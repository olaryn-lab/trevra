import { id, type Db } from '../db.js';
import { appendDomainEvent } from '../control-plane/events.js';
import { CITATION_SOURCE_KIND } from '../lead-capture/types.js';
import { LinkedInApiError } from './errors.js';
import { placePeopleInLeadList } from './lead-lists.js';
import { enrolListedContacts, getManagedCampaign } from './managed-campaigns.js';

/**
 * TRV-029 auto-enrol rules: new leads from one capture source or one lead list
 * enrol into one managed campaign without an operator in the loop.
 *
 * A RULE ONLY DECIDES WHO ARRIVES; ADMISSION IS UNCHANGED. The arrival is put in
 * the campaign's own lead list (as `moveManagedCampaignMembers` does) and
 * enrolled by `enrolListedContacts`, which is `enrolNewContacts` for named
 * contacts: the same derived member id, the same eligibility engine
 * (suppression, Never Contact, do-not-contact, duplicate profiles, one live
 * campaign per lead), and pending admission by the runner's seat capacity. A
 * suppressed arrival is enrolled as excluded, exactly as a manual import is.
 *
 * NEVER INTO A CAMPAIGN THAT IS NOT RUNNING. The campaign row is read FOR SHARE
 * with `status='running'` and an open admission window, so a pause or stop
 * either waits for this enrolment or is seen by it. An arrival while the
 * campaign is paused is skipped, not queued: resuming must not fire a backlog
 * nobody saw arrive.
 *
 * One append-only `linkedin_campaign.member_auto_enrolled` event per member a
 * rule creates. A replayed arrival conflicts on the derived member id and
 * writes nothing. Placements a rule makes do not trigger further rules.
 */

export type AutoEnrolSourceKind = 'capture_source' | 'lead_list';

export interface AutoEnrolRule {
  id: string;
  workspaceId: string;
  campaignId: string;
  sourceKind: AutoEnrolSourceKind;
  sourceId: string;
  /** The capture source's or lead list's current name, for display. */
  sourceName: string | null;
  status: 'active' | 'disabled';
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  disabledAt: string | null;
}

interface RuleRow {
  id: string;
  workspace_id: string;
  campaign_id: string;
  capture_source_id: string | null;
  lead_list_id: string | null;
  source_name: string | null;
  status: 'active' | 'disabled';
  created_by_user_id: string | null;
  created_at: unknown;
  updated_at: unknown;
  disabled_at: unknown;
}

const RULE_SELECT = `SELECT r.id,r.workspace_id,r.campaign_id,r.capture_source_id,r.lead_list_id,r.status,
       r.created_by_user_id,r.created_at,r.updated_at,r.disabled_at,COALESCE(cs.name,ll.name) AS source_name
  FROM linkedin_campaign_auto_enrol_rules r
  LEFT JOIN capture_sources cs ON cs.workspace_id=r.workspace_id AND cs.id=r.capture_source_id
  LEFT JOIN linkedin_lead_lists ll ON ll.workspace_id=r.workspace_id AND ll.id=r.lead_list_id`;

const iso = (value: unknown): string => new Date(String(value)).toISOString();

function toRule(row: RuleRow): AutoEnrolRule {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    campaignId: row.campaign_id,
    sourceKind: row.capture_source_id ? 'capture_source' : 'lead_list',
    sourceId: (row.capture_source_id ?? row.lead_list_id) as string,
    sourceName: row.source_name,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    disabledAt: row.disabled_at ? iso(row.disabled_at) : null
  };
}

export async function getAutoEnrolRule(
  db: Db,
  workspaceId: string,
  ruleId: string
): Promise<AutoEnrolRule | null> {
  const row = await db
    .prepare(`${RULE_SELECT} WHERE r.workspace_id=? AND r.id=?`)
    .get<RuleRow>(workspaceId, ruleId);
  return row ? toRule(row) : null;
}

export async function listAutoEnrolRules(
  db: Db,
  workspaceId: string,
  campaignId: string
): Promise<AutoEnrolRule[]> {
  const rows = await db
    .prepare(
      `${RULE_SELECT} WHERE r.workspace_id=? AND r.campaign_id=? ORDER BY r.created_at DESC, r.id`
    )
    .all<RuleRow>(workspaceId, campaignId);
  return rows.map(toRule);
}

export async function createAutoEnrolRule(
  db: Db,
  input: {
    workspaceId: string;
    campaignId: string;
    sourceKind: AutoEnrolSourceKind;
    sourceId: string;
    actorUserId: string;
  },
  now: Date = new Date()
): Promise<AutoEnrolRule> {
  return db.transaction(async (tx) => {
    const campaign = await tx
      .prepare(
        'SELECT status,lead_list_id FROM linkedin_campaigns WHERE workspace_id=? AND id=? FOR SHARE'
      )
      .get<{ status: string; lead_list_id: string }>(input.workspaceId, input.campaignId);
    if (!campaign) throw new LinkedInApiError('Managed campaign not found', 404);
    if (campaign.status === 'stopped' || campaign.status === 'completed')
      throw new LinkedInApiError(
        `A ${campaign.status} campaign cannot take an auto-enrol rule.`,
        409
      );
    if (input.sourceKind === 'capture_source') {
      const source = await tx
        .prepare('SELECT kind FROM capture_sources WHERE workspace_id=? AND id=?')
        .get<{ kind: string }>(input.workspaceId, input.sourceId);
      // A citation source feeds a brand watch, never People.
      if (!source || source.kind === CITATION_SOURCE_KIND)
        throw new LinkedInApiError('Capture source not found', 404);
    } else {
      const list = await tx
        .prepare('SELECT id FROM linkedin_lead_lists WHERE workspace_id=? AND id=?')
        .get<{ id: string }>(input.workspaceId, input.sourceId);
      if (!list) throw new LinkedInApiError('Lead list not found', 404);
      if (list.id === campaign.lead_list_id)
        throw new LinkedInApiError(
          'This campaign already enrols every lead added to its own list; choose another list.',
          400
        );
    }
    const ruleId = id('aer');
    const timestamp = now.toISOString();
    const inserted = await tx
      .prepare(
        `INSERT INTO linkedin_campaign_auto_enrol_rules
           (id,workspace_id,campaign_id,capture_source_id,lead_list_id,status,created_by_user_id,created_at,updated_at)
         VALUES (?,?,?,?,?,'active',?,?,?) ON CONFLICT DO NOTHING RETURNING id`
      )
      .get<{ id: string }>(
        ruleId,
        input.workspaceId,
        input.campaignId,
        input.sourceKind === 'capture_source' ? input.sourceId : null,
        input.sourceKind === 'lead_list' ? input.sourceId : null,
        input.actorUserId,
        timestamp,
        timestamp
      );
    if (!inserted)
      throw new LinkedInApiError(
        'This campaign already has an active auto-enrol rule for that source.',
        409
      );
    await appendDomainEvent(tx, {
      workspaceId: input.workspaceId,
      streamType: 'linkedin_campaign_auto_enrol_rule',
      streamId: ruleId,
      eventType: 'linkedin_campaign.auto_enrol_rule_created',
      actorType: 'human',
      actorId: input.actorUserId,
      payload: {
        campaignId: input.campaignId,
        sourceKind: input.sourceKind,
        sourceId: input.sourceId
      },
      occurredAt: now
    });
    const rule = await getAutoEnrolRule(tx, input.workspaceId, ruleId);
    if (!rule) throw new Error('Auto-enrol rule could not be read back');
    return rule;
  });
}

/** Disabled, not deleted: the rule stays as the record of why members arrived. */
export async function disableAutoEnrolRule(
  db: Db,
  input: { workspaceId: string; ruleId: string; actorUserId: string },
  now: Date = new Date()
): Promise<AutoEnrolRule> {
  return db.transaction(async (tx) => {
    const timestamp = now.toISOString();
    const row = await tx
      .prepare(
        `UPDATE linkedin_campaign_auto_enrol_rules
         SET status='disabled',disabled_at=?,disabled_by_user_id=?,updated_at=?
         WHERE workspace_id=? AND id=? AND status='active' RETURNING campaign_id`
      )
      .get<{ campaign_id: string }>(
        timestamp,
        input.actorUserId,
        timestamp,
        input.workspaceId,
        input.ruleId
      );
    if (!row) throw new LinkedInApiError('Active auto-enrol rule not found', 404);
    await appendDomainEvent(tx, {
      workspaceId: input.workspaceId,
      streamType: 'linkedin_campaign_auto_enrol_rule',
      streamId: input.ruleId,
      eventType: 'linkedin_campaign.auto_enrol_rule_disabled',
      actorType: 'human',
      actorId: input.actorUserId,
      payload: { campaignId: row.campaign_id },
      occurredAt: now
    });
    const rule = await getAutoEnrolRule(tx, input.workspaceId, input.ruleId);
    if (!rule) throw new Error('Auto-enrol rule could not be read back');
    return rule;
  });
}

/** Active rules for one source, locked against a concurrent disable. */
async function activeRules(
  tx: Db,
  workspaceId: string,
  source: { column: 'capture_source_id' | 'lead_list_id'; id: string }
): Promise<Array<{ id: string; campaign_id: string }>> {
  return tx
    .prepare(
      `SELECT id,campaign_id FROM linkedin_campaign_auto_enrol_rules
       WHERE workspace_id=? AND ${source.column}=? AND status='active'
       ORDER BY campaign_id,id FOR SHARE`
    )
    .all<{ id: string; campaign_id: string }>(workspaceId, source.id);
}

/**
 * The campaign a rule targets, if it may enrol RIGHT NOW: running, inside its
 * admission window, with steps. FOR SHARE holds off a pause/stop until this
 * transaction ends. The advisory lock serializes concurrent auto-enrolments
 * into one campaign, so two arrivals never race through the whole-campaign
 * eligibility pass. Rules are visited in campaign order, so the locks are too.
 *
 * lc-debt: the runner's own `enrolNewContacts` pass does not take this lock;
 * a concurrent eligibility UPDATE can still deadlock and is retried by the
 * sender (capture) or the operator (import). Upgrade path: run the tick's
 * enrolment in a transaction under the same lock.
 */
async function enrollableCampaign(tx: Db, workspaceId: string, campaignId: string, now: Date) {
  const timestamp = now.toISOString();
  const open = await tx
    .prepare(
      `SELECT id FROM linkedin_campaigns
       WHERE workspace_id=? AND id=? AND status='running'
         AND (scheduled_start_at IS NULL OR scheduled_start_at <= ?::timestamptz)
         AND (scheduled_end_at IS NULL OR scheduled_end_at > ?::timestamptz)
       FOR SHARE`
    )
    .get<{ id: string }>(workspaceId, campaignId, timestamp, timestamp);
  if (!open) return null;
  await tx
    .prepare('SELECT pg_advisory_xact_lock(hashtextextended(?,0)) AS locked')
    .get(`linkedin-campaign-auto-enrol\u001f${workspaceId}\u001f${campaignId}`);
  const campaign = await getManagedCampaign(tx, workspaceId, campaignId);
  if (!campaign || campaign.steps.length === 0) return null;
  return campaign;
}

async function recordEnrolments(
  tx: Db,
  input: {
    workspaceId: string;
    ruleId: string;
    campaignId: string;
    sourceKind: AutoEnrolSourceKind;
    sourceId: string;
    correlationId: string | null;
  },
  enrolled: Awaited<ReturnType<typeof enrolListedContacts>>,
  now: Date
): Promise<void> {
  if (enrolled.length === 0) return;
  const people = new Map(
    (
      await tx
        .prepare(
          'SELECT id,person_id FROM linkedin_lead_contacts WHERE workspace_id=? AND id = ANY(?::text[])'
        )
        .all<{ id: string; person_id: string | null }>(
          input.workspaceId,
          enrolled.map((member) => member.contactId)
        )
    ).map((row) => [row.id, row.person_id])
  );
  for (const member of enrolled)
    await appendDomainEvent(tx, {
      workspaceId: input.workspaceId,
      streamType: 'linkedin_campaign_member',
      streamId: member.memberId,
      eventType: 'linkedin_campaign.member_auto_enrolled',
      actorType: 'system',
      actorId: input.ruleId,
      correlationId: input.correlationId,
      payload: {
        ruleId: input.ruleId,
        campaignId: input.campaignId,
        memberId: member.memberId,
        leadContactId: member.contactId,
        personId: people.get(member.contactId) ?? null,
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
        status: member.status,
        exclusionReason: member.exclusionReason
      },
      occurredAt: now
    });
}

/**
 * A capture just created a submission for `personId`. Called inside the
 * capture's own transaction, so the submission and its enrolments commit
 * together; a duplicate (retried) submission never reaches here.
 */
export async function applyCaptureAutoEnrolRules(
  tx: Db,
  input: {
    workspaceId: string;
    captureSourceId: string;
    personId: string;
    company?: string | null;
    submissionId: string;
  },
  now: Date = new Date()
): Promise<void> {
  const rules = await activeRules(tx, input.workspaceId, {
    column: 'capture_source_id',
    id: input.captureSourceId
  });
  for (const rule of rules) {
    const campaign = await enrollableCampaign(tx, input.workspaceId, rule.campaign_id, now);
    if (!campaign) continue;
    const [placed] = await placePeopleInLeadList(
      tx,
      {
        workspaceId: input.workspaceId,
        listId: campaign.leadListId,
        people: [{ personId: input.personId, company: input.company ?? null }],
        emailProvenance: 'first_party'
      },
      now
    );
    if (!placed?.contactId) continue;
    const enrolled = await enrolListedContacts(
      tx,
      input.workspaceId,
      campaign,
      [placed.contactId],
      now
    );
    await recordEnrolments(
      tx,
      {
        workspaceId: input.workspaceId,
        ruleId: rule.id,
        campaignId: campaign.id,
        sourceKind: 'capture_source',
        sourceId: input.captureSourceId,
        correlationId: input.submissionId
      },
      enrolled,
      now
    );
  }
}

/**
 * Leads just arrived in `listId` (new rows, or existing leads newly added to
 * it). Called inside the import's own transaction.
 */
export async function applyListAutoEnrolRules(
  tx: Db,
  input: { workspaceId: string; listId: string; leadContactIds: readonly string[] },
  now: Date = new Date()
): Promise<void> {
  const contactIds = [...new Set(input.leadContactIds.filter(Boolean))].sort();
  if (contactIds.length === 0) return;
  const rules = await activeRules(tx, input.workspaceId, {
    column: 'lead_list_id',
    id: input.listId
  });
  for (const rule of rules) {
    const campaign = await enrollableCampaign(tx, input.workspaceId, rule.campaign_id, now);
    if (!campaign || campaign.leadListId === input.listId) continue;
    await tx
      .prepare(
        `INSERT INTO linkedin_lead_list_members (workspace_id,list_id,contact_id,created_at)
         SELECT l.workspace_id, ?, l.id, ?::timestamptz FROM linkedin_lead_contacts l
         WHERE l.workspace_id=? AND l.id = ANY(?::text[]) ORDER BY l.id
         ON CONFLICT DO NOTHING`
      )
      .run(campaign.leadListId, now.toISOString(), input.workspaceId, contactIds);
    const enrolled = await enrolListedContacts(tx, input.workspaceId, campaign, contactIds, now);
    await recordEnrolments(
      tx,
      {
        workspaceId: input.workspaceId,
        ruleId: rule.id,
        campaignId: campaign.id,
        sourceKind: 'lead_list',
        sourceId: input.listId,
        correlationId: null
      },
      enrolled,
      now
    );
  }
}
