import type { Db } from './db.js';
import { campaignExecutionState } from './linkedin/execution-state.js';
import type { LinkedInCheckName } from './linkedin/guard.js';
import {
  MILESTONE_KINDS_SQL,
  MILESTONE_LABELS,
  isMilestoneKind,
  milestoneEvidencePath
} from './lead-capture/milestones.js';

export type TodayItemKind =
  | 'safety_block'
  | 'verified_reply'
  | 'delivery_unknown'
  | 'approval_waiting'
  | 'inbound_submission'
  | 'qualification_decision'
  | 'high_priority_account'
  | 'capacity_block'
  | 'agent_blocked'
  | 'agent_working'
  | 'playbook_working'
  | 'campaign_working'
  | 'delivery_sent'
  | 'verified_reply_result'
  | 'opportunity_closed'
  | 'milestone_reached'
  | 'customer_cancelled'
  | 'meeting_upcoming'
  | 'meeting_held'
  | 'deliverability_blocked';

export interface TodayItem {
  id: string;
  kind: TodayItemKind;
  priority: number;
  title: string;
  detail: string;
  href: string;
  observedAt: string;
  reference: { type: string; id: string };
  metadata: Record<string, unknown>;
}

export interface TodayPayload {
  needsAttention: TodayItem[];
  working: TodayItem[];
  recentResults: TodayItem[];
}

function iso(value: unknown, fallback: Date): string {
  const parsed = value ? new Date(String(value)) : fallback;
  return Number.isNaN(parsed.getTime()) ? fallback.toISOString() : parsed.toISOString();
}

function validTimeZone(zone: unknown): string {
  const candidate = typeof zone === 'string' ? zone.trim() : '';
  if (!candidate) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: candidate });
    return candidate;
  } catch {
    return 'UTC';
  }
}

function meetingTime(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(new Date(value));
}

function sortAttention(items: TodayItem[]): TodayItem[] {
  return [...items].sort((left, right) => {
    if (left.priority !== right.priority) return left.priority - right.priority;
    const time = left.observedAt.localeCompare(right.observedAt);
    return time || left.id.localeCompare(right.id);
  });
}

function sortRecent(items: TodayItem[]): TodayItem[] {
  return [...items].sort((left, right) => {
    const time = right.observedAt.localeCompare(left.observedAt);
    if (time) return time;
    if (left.priority !== right.priority) return left.priority - right.priority;
    return left.id.localeCompare(right.id);
  });
}

const ACTIONABLE_CAPACITY_CHECKS = new Set<LinkedInCheckName>([
  'warmup-ceiling',
  'campaign-warmup',
  'rolling-24h',
  'rolling-7d',
  'rolling-30d',
  'day-over-day-delta',
  'acceptance-rate',
  'inmail-monthly-quota',
  'pending-invite-backlog'
]);

function capacityTitle(campaignName: string, check: LinkedInCheckName, kind: string): string {
  switch (check) {
    case 'acceptance-rate':
      return `${campaignName} is throttled by acceptance rate`;
    case 'pending-invite-backlog':
      return `${campaignName} has no invite capacity`;
    case 'inmail-monthly-quota':
      return `${campaignName} reached the InMail quota`;
    case 'campaign-warmup':
      return `${campaignName} reached its campaign ramp`;
    case 'warmup-ceiling':
      return `${campaignName} reached its account warm-up ceiling`;
    default:
      return `${campaignName} reached its ${kind.replaceAll('_', ' ')} capacity`;
  }
}

/**
 * Deterministic human-attention projection for the GTM OS.
 *
 * This is deliberately a read model over existing durable GTM state. It is not
 * a new job/task table and it does not let a model decide what is urgent. Each
 * class has an explicit priority and a canonical destination.
 */
export async function getToday(
  db: Db,
  workspaceId: string,
  now: Date = new Date()
): Promise<TodayPayload> {
  const recentSince = new Date(now.getTime() - 7 * 86_400_000).toISOString();

  const [
    seatRows,
    replyRows,
    unknownRows,
    approvalRows,
    demandRows,
    inboundRows,
    hotRows,
    agentRows,
    failedAgentRows,
    playbookRows,
    campaignRows,
    sentDeliveryRows,
    verifiedReplyRows,
    closedOpportunityRows
  ] = await Promise.all([
    db
      .prepare(
        `SELECT seat_key,label,posture,paused_reason,updated_at
         FROM linkedin_seats
         WHERE workspace_id=? AND posture IN ('paused','cooldown')
         ORDER BY updated_at ASC LIMIT 20`
      )
      .all<Record<string, unknown>>(workspaceId),
    db
      .prepare(
        `SELECT t.id,t.name,t.snippet,t.last_message_at,t.synced_at,t.campaign_id
         FROM linkedin_threads t
         WHERE t.workspace_id=? AND t.unread=TRUE
           AND EXISTS (
             SELECT 1 FROM linkedin_messages m
             WHERE m.workspace_id=t.workspace_id AND m.thread_id=t.id AND m.direction='in'
           )
         ORDER BY COALESCE(t.last_message_at,t.synced_at) ASC NULLS LAST,t.id ASC
         LIMIT 50`
      )
      .all<Record<string, unknown>>(workspaceId),
    db
      .prepare(
        `SELECT id,campaign_id,member_id,kind,status,outcome_known,last_error,updated_at
         FROM linkedin_campaign_channel_actions
         WHERE workspace_id=? AND (status='unknown' OR outcome_known=FALSE)
         ORDER BY updated_at ASC,id ASC LIMIT 50`
      )
      .all<Record<string, unknown>>(workspaceId),
    db
      .prepare(
        `SELECT s.id,s.step_id,s.updated_at,r.id AS run_id,r.playbook_key
         FROM playbook_step_runs s
         JOIN playbook_runs r ON r.id=s.playbook_run_id
         WHERE r.workspace_id=? AND s.status='waiting_approval'
         ORDER BY s.updated_at ASC,s.id ASC LIMIT 50`
      )
      .all<Record<string, unknown>>(workspaceId),
    db
      .prepare(
        `SELECT r.id,r.type,r.person_id,r.account_id,r.title,r.summary,r.recommended_action,r.updated_at,
                p.name AS person_name,p.email AS person_email,a.name AS account_name,
                EXISTS (
                  SELECT 1 FROM recommendation_evidence re
                  WHERE re.recommendation_id=r.id AND re.source_type='inbound_submission'
                ) AS has_inbound,
                (
                  SELECT re.source_id FROM recommendation_evidence re
                  WHERE re.recommendation_id=r.id AND re.source_type='discovery_plan'
                  ORDER BY re.created_at,re.id LIMIT 1
                ) AS discovery_source_id,
                (
                  SELECT re.external_url FROM recommendation_evidence re
                  WHERE re.recommendation_id=r.id AND re.source_type='discovery_plan'
                  ORDER BY re.created_at,re.id LIMIT 1
                ) AS discovery_url
         FROM recommendations r
         LEFT JOIN contacts p ON p.workspace_id=r.workspace_id AND p.id=r.person_id
         LEFT JOIN accounts a ON a.workspace_id=r.workspace_id AND a.id=r.account_id
         WHERE r.workspace_id=? AND r.type IN ('qualified_demand','person_discovery')
           AND r.status NOT IN ('dismissed','completed')
           AND (r.snoozed_until IS NULL OR r.snoozed_until<=CURRENT_TIMESTAMP)
           AND r.updated_at>=?::timestamptz
         ORDER BY r.updated_at ASC,r.id ASC LIMIT 50`
      )
      .all<Record<string, unknown>>(workspaceId, recentSince),
    db
      .prepare(
        `SELECT i.id,i.contact_id,i.account_id,i.kind,i.person_name,i.person_email,i.person_phone,i.message,i.received_at
         FROM inbound_submissions i
         WHERE i.workspace_id=? AND i.received_at>=?::timestamptz
           AND i.kind NOT IN ${MILESTONE_KINDS_SQL}
           AND NOT EXISTS (
             SELECT 1
             FROM recommendation_evidence re
             JOIN recommendations r ON r.id=re.recommendation_id
             WHERE r.workspace_id=i.workspace_id
               AND r.type IN ('qualified_demand','person_discovery')
               AND r.status NOT IN ('dismissed','completed')
               AND r.updated_at>=?::timestamptz
               AND re.source_type='inbound_submission'
               AND re.source_id=i.id
           )
         ORDER BY i.received_at ASC,i.id ASC LIMIT 50`
      )
      .all<Record<string, unknown>>(workspaceId, recentSince, recentSince),
    db
      .prepare(
        `SELECT a.id,a.name,a.domain,s.score,s.newest_signal_at,s.computed_at
         FROM account_scores s
         JOIN accounts a ON a.id=s.account_id AND a.workspace_id=s.workspace_id
         WHERE s.workspace_id=? AND s.tier='hot'
           AND COALESCE(s.newest_signal_at,s.computed_at)>=?::timestamptz
           -- A paying customer is not new demand: its milestones can score hot.
           AND NOT EXISTS (
             SELECT 1 FROM opportunities o
             WHERE o.workspace_id=s.workspace_id
               AND o.account_id=s.account_id
               AND o.stage='won'
           )
           AND NOT EXISTS (
             SELECT 1 FROM recommendations r
             WHERE r.workspace_id=s.workspace_id
               AND r.account_id=s.account_id
               AND r.type IN ('qualified_demand','person_discovery')
               AND r.status NOT IN ('dismissed','completed')
               AND r.updated_at>=?::timestamptz
           )
         ORDER BY COALESCE(s.newest_signal_at,s.computed_at) ASC,a.id ASC LIMIT 50`
      )
      .all<Record<string, unknown>>(workspaceId, recentSince, recentSince),
    db
      .prepare(
        `SELECT r.id,r.goal,r.step_count,r.started_at,r.stop_requested_at,
                COALESCE(a.name,'GTM Agent') AS agent_name
         FROM agent_runs r
         LEFT JOIN agents a ON a.workspace_id=r.workspace_id AND a.id=r.agent_id
         WHERE r.workspace_id=? AND r.status='running'
         ORDER BY r.started_at ASC,r.id ASC LIMIT 20`
      )
      .all<Record<string, unknown>>(workspaceId),
    db
      .prepare(
        `SELECT r.id,r.agent_id,r.goal,r.error,r.started_at,r.finished_at,
                COALESCE(a.name,'GTM Agent') AS agent_name
         FROM agent_runs r
         LEFT JOIN agents a ON a.workspace_id=r.workspace_id AND a.id=r.agent_id
         WHERE r.workspace_id=? AND r.status='failed'
           AND COALESCE(r.finished_at,r.started_at)>=?::timestamptz
           AND NOT EXISTS (
             SELECT 1 FROM agent_runs newer
             WHERE newer.workspace_id=r.workspace_id
               AND newer.agent_id=r.agent_id
               AND (
                 newer.started_at>r.started_at OR
                 (newer.started_at=r.started_at AND newer.id>r.id)
               )
           )
         ORDER BY COALESCE(r.finished_at,r.started_at) ASC,r.id ASC
         LIMIT 20`
      )
      .all<Record<string, unknown>>(workspaceId, recentSince),
    db
      .prepare(
        `SELECT id,playbook_key,status,current_step_id,updated_at
         FROM playbook_runs
         WHERE workspace_id=? AND status IN ('queued','running')
         ORDER BY updated_at ASC,id ASC LIMIT 20`
      )
      .all<Record<string, unknown>>(workspaceId),
    db
      .prepare(
        `SELECT c.id,c.name,c.started_at,c.updated_at,
                (SELECT COUNT(*)::int FROM linkedin_campaign_members m
                 WHERE m.workspace_id=c.workspace_id AND m.campaign_id=c.id
                   AND m.status IN ('pending','active','waiting','manual','paused')) AS active_count
         FROM linkedin_campaigns c
         WHERE c.workspace_id=? AND c.status='running'
         ORDER BY c.updated_at ASC,c.id ASC LIMIT 20`
      )
      .all<Record<string, unknown>>(workspaceId),
    db
      .prepare(
        `SELECT id,recipient,purpose,provider,external_ref,sent_at,updated_at
         FROM gtm_deliveries
         WHERE workspace_id=? AND status='sent'
           AND COALESCE(sent_at,updated_at)>=?::timestamptz
         ORDER BY COALESCE(sent_at,updated_at) DESC,id DESC LIMIT 50`
      )
      .all<Record<string, unknown>>(workspaceId, recentSince),
    db
      .prepare(
        `SELECT m.id,m.conversation_id,m.channel,m.body,m.occurred_at,
                p.id AS person_id,p.name AS person_name,p.email AS person_email
         FROM conversation_messages m
         JOIN conversations c
           ON c.workspace_id=m.workspace_id AND c.id=m.conversation_id
         JOIN contacts p
           ON p.workspace_id=c.workspace_id AND p.id=c.person_id
         WHERE m.workspace_id=? AND m.direction='inbound'
           AND m.verification_status='verified' AND m.outcome_kind='reply'
           AND m.occurred_at>=?::timestamptz
           AND EXISTS (
             SELECT 1 FROM conversation_messages later
             WHERE later.workspace_id=m.workspace_id
               AND later.conversation_id=m.conversation_id
               AND later.direction='outbound'
               AND later.occurred_at>m.occurred_at
           )
         ORDER BY m.occurred_at DESC,m.id DESC LIMIT 50`
      )
      .all<Record<string, unknown>>(workspaceId, recentSince),
    db
      .prepare(
        `SELECT o.id,o.stage,o.title,o.closed_at,o.person_id,o.account_id,
                p.name AS person_name,a.name AS account_name
         FROM opportunities o
         LEFT JOIN contacts p ON p.workspace_id=o.workspace_id AND p.id=o.person_id
         LEFT JOIN accounts a ON a.workspace_id=o.workspace_id AND a.id=o.account_id
         WHERE o.workspace_id=? AND o.stage IN ('won','lost')
           AND o.closed_at IS NOT NULL AND o.closed_at>=?::timestamptz
         ORDER BY o.closed_at DESC,o.id DESC LIMIT 50`
      )
      .all<Record<string, unknown>>(workspaceId, recentSince)
  ]);

  const emailReplyRows = await db
    .prepare(
      `SELECT c.id AS conversation_id,m.id AS message_id,m.body,m.occurred_at,m.source_type,
              m.outcome_kind,p.id AS person_id,p.name AS person_name,p.email AS person_email
       FROM conversations c
       JOIN contacts p ON p.workspace_id=c.workspace_id AND p.id=c.person_id
       JOIN LATERAL (
         SELECT cm.id,cm.body,cm.occurred_at,cm.channel,cm.direction,
                cm.verification_status,cm.outcome_kind,cm.source_type
         FROM conversation_messages cm
         WHERE cm.workspace_id=c.workspace_id AND cm.conversation_id=c.id
         ORDER BY cm.occurred_at DESC,cm.created_at DESC,cm.id DESC
         LIMIT 1
       ) m ON TRUE
       WHERE c.workspace_id=? AND m.channel='email' AND m.direction='inbound'
         AND m.verification_status='verified'
         AND (
           m.outcome_kind='reply'
           -- An unsubscribe that did not thread to Trevra's own mail suppressed
           -- nobody (only a threaded one is verified intent). A founder decides.
           OR (
             m.outcome_kind='unsubscribe' AND m.source_type='inbound_mailbox_message'
             AND NOT EXISTS (
               SELECT 1 FROM suppressions s
               WHERE s.workspace_id=c.workspace_id AND s.lifted_at IS NULL
                 AND s.channel IN ('all','email')
                 AND (s.person_id=p.id
                      OR (p.email_normalized IS NOT NULL AND s.email_normalized=p.email_normalized))
             )
           )
         )
       ORDER BY m.occurred_at ASC,c.id ASC LIMIT 50`
    )
    .all<Record<string, unknown>>(workspaceId);

  // A failing sending domain needs a human only while it is in use: someone
  // planned email outreach from it in the last 30 days and a live connected
  // mailbox still sends from it.
  const deliverabilityRows = await db
    .prepare(
      `SELECT d.domain,d.provider,d.blockers_json,d.checked_at
       FROM email_deliverability_checks d
       WHERE d.workspace_id=? AND d.status='fail'
         AND d.outreach_requested_at IS NOT NULL
         AND d.outreach_requested_at>=?::timestamptz
         AND EXISTS (
           SELECT 1 FROM connections c
           WHERE c.workspace_id=d.workspace_id AND c.status='connected' AND c.is_demo=0
             AND c.mailbox_address IS NOT NULL
             AND SPLIT_PART(c.mailbox_address,'@',2)=d.domain
             AND CASE
                   WHEN c.provider IN ('gmail','google-mail') THEN 'google'
                   WHEN c.provider IN ('microsoft','outlook') THEN 'microsoft'
                 END=d.provider
         )
       ORDER BY d.domain ASC,d.provider ASC LIMIT 10`
    )
    .all<Record<string, unknown>>(
      workspaceId,
      new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
    );

  // Capacity is only worth human attention when work is due now and the same
  // pre-execution gate the worker uses is refusing on a tunable/rate boundary.
  // Clock-only waits (business hours/weekend), cooldowns, target suppression,
  // duplicate protection and seat posture have their own semantics and must not
  // be relabeled as capacity incidents here.
  const capacityCandidateRows = await db
    .prepare(
      `SELECT c.id,c.name,c.updated_at,MIN(a.planned_for) AS earliest_due_at
       FROM linkedin_campaigns c
       JOIN linkedin_actions a
         ON a.workspace_id=c.workspace_id AND a.campaign_id=c.id
       WHERE c.workspace_id=? AND c.status='running'
         AND a.status='planned' AND a.claimed_at IS NULL
         AND a.settlement_hold_at IS NULL
         AND a.planned_for IS NOT NULL AND a.planned_for<=?::timestamptz
       GROUP BY c.id,c.name,c.updated_at
       ORDER BY MIN(a.planned_for) ASC,c.id ASC
       LIMIT 10`
    )
    .all<Record<string, unknown>>(workspaceId, now.toISOString());

  const capacityStates = (
    await Promise.all(
      capacityCandidateRows.map(async (row) => {
        try {
          return {
            row,
            state: await campaignExecutionState(db, workspaceId, String(row.id), now)
          };
        } catch {
          return null;
        }
      })
    )
  ).filter(
    (
      entry
    ): entry is {
      row: Record<string, unknown>;
      state: Awaited<ReturnType<typeof campaignExecutionState>>;
    } => entry !== null
  );

  const items: TodayItem[] = [];
  const working: TodayItem[] = [];
  const recentResults: TodayItem[] = [];

  for (const row of seatRows) {
    const label = String(row.label ?? row.seat_key ?? 'LinkedIn account');
    const posture = String(row.posture ?? 'paused');
    const reason = String(row.paused_reason ?? '').trim();
    items.push({
      id: `safety:${String(row.seat_key ?? 'owner')}`,
      kind: 'safety_block',
      priority: 10,
      title: `${label} needs attention`,
      detail: reason || `LinkedIn sending is ${posture}.`,
      href: '/setup/workspace',
      observedAt: iso(row.updated_at, now),
      reference: { type: 'linkedin_seat', id: String(row.seat_key ?? 'owner') },
      metadata: { posture }
    });
  }

  for (const row of replyRows) {
    const name = String(row.name ?? '').trim() || 'LinkedIn reply';
    const snippet = String(row.snippet ?? '').trim();
    items.push({
      id: `reply:${String(row.id)}`,
      kind: 'verified_reply',
      priority: 20,
      title: `Reply from ${name}`,
      detail: snippet || 'An inbound LinkedIn message needs review.',
      href: '/outreach/inbox',
      observedAt: iso(row.last_message_at ?? row.synced_at, now),
      reference: { type: 'linkedin_thread', id: String(row.id) },
      metadata: {
        campaignId: row.campaign_id ? String(row.campaign_id) : null,
        channel: 'linkedin'
      }
    });
  }

  for (const row of emailReplyRows) {
    const name =
      String(row.person_name ?? '').trim() ||
      String(row.person_email ?? '').trim() ||
      'Email reply';
    const inboundMailbox = row.source_type === 'inbound_mailbox_message';
    const unsubscribeReview = row.outcome_kind === 'unsubscribe';
    const excerpt = String(row.body ?? '')
      .trim()
      .slice(0, 240);
    items.push({
      id: `email-reply:${String(row.message_id)}`,
      kind: 'verified_reply',
      priority: 20,
      title: unsubscribeReview
        ? `${name} may want to unsubscribe`
        : inboundMailbox
          ? `New email from ${name}`
          : `Reply from ${name}`,
      detail: unsubscribeReview
        ? `This email did not reply to one Trevra sent, so nobody was suppressed. Review it and suppress ${name} if they asked to stop.${excerpt ? ` "${excerpt}"` : ''}`
        : excerpt || 'A verified inbound email needs review.',
      href: '/outreach/inbox',
      observedAt: iso(row.occurred_at, now),
      reference: { type: 'conversation_message', id: String(row.message_id) },
      metadata: {
        conversationId: String(row.conversation_id),
        personId: String(row.person_id),
        channel: 'email',
        inboundMailbox,
        unsubscribeReview
      }
    });
  }

  for (const row of deliverabilityRows) {
    const domain = String(row.domain);
    const blockers = Array.isArray(row.blockers_json)
      ? (row.blockers_json as Array<{ code?: unknown; message?: unknown }>)
      : [];
    items.push({
      id: `deliverability:${domain}:${String(row.provider)}`,
      kind: 'deliverability_blocked',
      priority: 25,
      title: `Email from ${domain} is blocked`,
      detail:
        String(blockers[0]?.message ?? '').trim() ||
        `SPF, DKIM or DMARC for ${domain} does not pass, so Trevra will not plan email outreach from it.`,
      href: '/setup/workspace',
      observedAt: iso(row.checked_at, now),
      reference: { type: 'email_domain', id: domain },
      metadata: {
        provider: String(row.provider),
        blockerCodes: blockers.map((blocker) => String(blocker.code ?? '')).filter(Boolean)
      }
    });
  }

  for (const row of unknownRows) {
    items.push({
      id: `delivery:${String(row.id)}`,
      kind: 'delivery_unknown',
      priority: 30,
      title: 'Delivery outcome is unknown',
      detail:
        String(row.last_error ?? '').trim() ||
        `Trevra cannot safely tell whether this ${String(row.kind ?? 'channel')} action completed.`,
      href: '/outreach',
      observedAt: iso(row.updated_at, now),
      reference: { type: 'campaign_channel_action', id: String(row.id) },
      metadata: {
        campaignId: String(row.campaign_id ?? ''),
        memberId: String(row.member_id ?? ''),
        channel: String(row.kind ?? '')
      }
    });
  }

  for (const row of approvalRows) {
    items.push({
      id: `approval:${String(row.id)}`,
      kind: 'approval_waiting',
      priority: 40,
      title: 'Approval waiting',
      detail: `${String(row.playbook_key ?? 'GTM playbook')} is waiting at ${String(row.step_id ?? 'an approval step')}.`,
      href: '/loop',
      observedAt: iso(row.updated_at, now),
      reference: { type: 'playbook_step_run', id: String(row.id) },
      metadata: { playbookRunId: String(row.run_id ?? '') }
    });
  }

  for (const row of demandRows) {
    const personName =
      row.person_name || row.person_email ? String(row.person_name ?? row.person_email) : null;
    const accountName = String(row.account_name ?? 'Account');
    const recommendationType = String(row.type ?? 'qualified_demand');
    const discoverySourceId = row.discovery_source_id ? String(row.discovery_source_id) : '';
    const discoveryKind = discoverySourceId.includes(':') ? discoverySourceId.split(':', 1)[0] : '';
    const discoveryUrl = row.discovery_url ? String(row.discovery_url) : '';
    const discoveryHref =
      recommendationType === 'person_discovery' &&
      discoveryUrl &&
      ['company_employees', 'search'].includes(discoveryKind)
        ? `/outreach?focus=leads&kind=${encodeURIComponent(discoveryKind)}&url=${encodeURIComponent(discoveryUrl)}`
        : '/outreach';
    items.push({
      id: `demand:${String(row.id)}`,
      kind: 'qualification_decision',
      priority: 45,
      title: String(
        row.title ??
          (personName
            ? `Talk to ${personName} at ${accountName}`
            : `Find the right person at ${accountName}`)
      ),
      detail: String(row.summary ?? 'Several independent commercial signals line up now.'),
      href:
        recommendationType === 'person_discovery'
          ? discoveryHref
          : String(row.recommended_action ?? '') === 'reply'
            ? '/outreach/inbox'
            : Boolean(row.has_inbound)
              ? '/outreach/inbound'
              : '/outreach',
      observedAt: iso(row.updated_at, now),
      reference: { type: 'recommendation', id: String(row.id) },
      metadata: {
        personId: row.person_id ? String(row.person_id) : null,
        accountId: row.account_id ? String(row.account_id) : null,
        recommendationType,
        demandOrigin:
          recommendationType === 'person_discovery'
            ? 'person_discovery'
            : Boolean(row.has_inbound)
              ? 'first_party'
              : 'known_contact',
        recommendedAction: String(row.recommended_action ?? ''),
        discoveryKind: discoveryKind || null,
        discoveryUrl: discoveryUrl || null
      }
    });
  }

  for (const row of inboundRows) {
    const who =
      String(row.person_name ?? '').trim() ||
      String(row.person_email ?? '').trim() ||
      String(row.person_phone ?? '').trim() ||
      'New inbound person';
    items.push({
      id: `inbound:${String(row.id)}`,
      kind: 'inbound_submission',
      priority: 50,
      title: who,
      detail:
        String(row.message ?? '').trim() ||
        `New ${String(row.kind ?? 'inbound')} submission needs qualification.`,
      href: '/outreach/inbound',
      observedAt: iso(row.received_at, now),
      reference: { type: 'inbound_submission', id: String(row.id) },
      metadata: {
        contactId: String(row.contact_id ?? ''),
        accountId: row.account_id ? String(row.account_id) : null,
        submissionKind: String(row.kind ?? '')
      }
    });
  }

  for (const row of hotRows) {
    const name = String(row.name ?? row.domain ?? 'Account');
    items.push({
      id: `account:${String(row.id)}`,
      kind: 'high_priority_account',
      priority: 70,
      title: `${name} became high priority`,
      detail: `Current GTM score: ${Number(row.score ?? 0)}. Review the evidence before acting.`,
      href: '/research',
      observedAt: iso(row.newest_signal_at ?? row.computed_at, now),
      reference: { type: 'account', id: String(row.id) },
      metadata: { domain: String(row.domain ?? ''), score: Number(row.score ?? 0) }
    });
  }

  for (const { row, state } of capacityStates) {
    const check = state.gate?.check ?? null;
    if (
      state.dueNow <= 0 ||
      !state.gate ||
      state.gate.allowed ||
      !check ||
      !ACTIONABLE_CAPACITY_CHECKS.has(check)
    ) {
      continue;
    }
    const campaignName = String(row.name ?? 'Campaign');
    items.push({
      id: `capacity:${String(row.id)}:${check}`,
      kind: 'capacity_block',
      priority: 80,
      title: capacityTitle(campaignName, check, state.gate.kind),
      detail:
        `${state.dueNow} due ${state.dueNow === 1 ? 'action is' : 'actions are'} blocked. ` +
        (state.gate.detail ??
          'The LinkedIn safety gate has no current capacity for the next action.'),
      href: '/outreach',
      observedAt: iso(row.earliest_due_at ?? row.updated_at, now),
      reference: { type: 'linkedin_campaign', id: String(row.id) },
      metadata: {
        check,
        channel: 'linkedin',
        actionKind: state.gate.kind,
        dueNow: state.dueNow,
        seatKey: state.seatKey
      }
    });
  }

  for (const row of agentRows) {
    const agentName = String(row.agent_name ?? 'GTM Agent');
    const stopping = Boolean(row.stop_requested_at);
    working.push({
      id: `agent:${String(row.id)}`,
      kind: 'agent_working',
      priority: 10,
      title: stopping ? `${agentName} is stopping` : `${agentName} is working`,
      detail: String(row.goal ?? 'Working on the current GTM goal.'),
      href: `/ledger/run/${encodeURIComponent(String(row.id))}`,
      observedAt: iso(row.started_at, now),
      reference: { type: 'agent_run', id: String(row.id) },
      metadata: { stepCount: Number(row.step_count ?? 0), stopping }
    });
  }

  for (const row of failedAgentRows) {
    const agentName = String(row.agent_name ?? 'GTM Agent');
    const error = String(row.error ?? '').trim();
    items.push({
      id: `agent-blocked:${String(row.id)}`,
      kind: 'agent_blocked',
      priority: 35,
      title: `${agentName} needs attention`,
      detail:
        error ||
        `The latest run failed while working on: ${String(row.goal ?? 'the assigned GTM goal')}`,
      href: `/ledger/run/${encodeURIComponent(String(row.id))}`,
      observedAt: iso(row.finished_at ?? row.started_at, now),
      reference: { type: 'agent_run', id: String(row.id) },
      metadata: {
        agentId: String(row.agent_id ?? ''),
        goal: String(row.goal ?? '')
      }
    });
  }

  for (const row of playbookRows) {
    const status = String(row.status ?? 'running');
    const currentStep = String(row.current_step_id ?? '').trim();
    working.push({
      id: `playbook:${String(row.id)}`,
      kind: 'playbook_working',
      priority: 20,
      title: `${String(row.playbook_key ?? 'GTM playbook')} is ${status === 'queued' ? 'queued' : 'running'}`,
      detail: currentStep
        ? `Current step: ${currentStep}.`
        : 'The durable GTM procedure is in progress.',
      href: `/ledger/run/${encodeURIComponent(String(row.id))}`,
      observedAt: iso(row.updated_at, now),
      reference: { type: 'playbook_run', id: String(row.id) },
      metadata: { status, currentStep: currentStep || null }
    });
  }

  for (const row of campaignRows) {
    const activeCount = Number(row.active_count ?? 0);
    working.push({
      id: `campaign:${String(row.id)}`,
      kind: 'campaign_working',
      priority: 30,
      title: `${String(row.name ?? 'Campaign')} is running`,
      detail:
        activeCount === 1
          ? '1 person is still in this campaign.'
          : `${activeCount} people are still in this campaign.`,
      href: '/outreach',
      observedAt: iso(row.started_at ?? row.updated_at, now),
      reference: { type: 'linkedin_campaign', id: String(row.id) },
      metadata: { activeCount }
    });
  }

  for (const row of sentDeliveryRows) {
    const recipient = String(row.recipient ?? '').trim() || 'recipient';
    recentResults.push({
      id: `delivery-sent:${String(row.id)}`,
      kind: 'delivery_sent',
      priority: 10,
      title: `Email sent to ${recipient}`,
      detail: `${String(row.purpose ?? 'outreach')} · ${String(row.provider ?? 'connected mailbox')}`,
      href: '/ledger',
      observedAt: iso(row.sent_at ?? row.updated_at, now),
      reference: { type: 'gtm_delivery', id: String(row.id) },
      metadata: {
        recipient,
        purpose: String(row.purpose ?? ''),
        provider: row.provider ? String(row.provider) : null,
        externalRef: row.external_ref ? String(row.external_ref) : null
      }
    });
  }

  for (const row of verifiedReplyRows) {
    const personName =
      String(row.person_name ?? '').trim() || String(row.person_email ?? '').trim() || 'A person';
    recentResults.push({
      id: `verified-result:${String(row.id)}`,
      kind: 'verified_reply_result',
      priority: 20,
      title: `Verified reply from ${personName}`,
      detail:
        String(row.body ?? '')
          .trim()
          .slice(0, 240) || 'A verified inbound reply was recorded.',
      href: '/outreach/inbox',
      observedAt: iso(row.occurred_at, now),
      reference: { type: 'conversation_message', id: String(row.id) },
      metadata: {
        conversationId: String(row.conversation_id ?? ''),
        personId: String(row.person_id ?? ''),
        channel: String(row.channel ?? '')
      }
    });
  }

  for (const row of closedOpportunityRows) {
    const stage = String(row.stage) === 'won' ? 'won' : 'lost';
    const who =
      String(row.account_name ?? '').trim() ||
      String(row.person_name ?? '').trim() ||
      String(row.title ?? 'Opportunity');
    recentResults.push({
      id: `opportunity-closed:${String(row.id)}`,
      kind: 'opportunity_closed',
      priority: 30,
      title: `${who}: ${stage}`,
      detail: String(row.title ?? 'GTM opportunity closed.'),
      href: '/outreach',
      observedAt: iso(row.closed_at, now),
      reference: { type: 'opportunity', id: String(row.id) },
      metadata: {
        stage,
        personId: row.person_id ? String(row.person_id) : null,
        accountId: row.account_id ? String(row.account_id) : null
      }
    });
  }

  // Product milestones are first-party outcomes, not inbound to qualify: the
  // NOT IN above keeps them out of the inbound class. A cancellation needs a
  // human before any outreach; everything else is a result.
  const milestoneRows = await db
    .prepare(
      `SELECT m.id,m.kind,m.contact_id,m.account_id,m.source_type,m.occurred_at,m.created_at,
              p.name AS person_name,p.email AS person_email,a.name AS account_name
       FROM product_milestones m
       JOIN contacts p ON p.workspace_id=m.workspace_id AND p.id=m.contact_id
       LEFT JOIN accounts a ON a.workspace_id=m.workspace_id AND a.id=m.account_id
       WHERE m.workspace_id=? AND m.created_at>=?::timestamptz
       ORDER BY m.created_at DESC,m.id DESC LIMIT 50`
    )
    .all<Record<string, unknown>>(workspaceId, recentSince);

  for (const row of milestoneRows) {
    const kind = String(row.kind);
    if (!isMilestoneKind(kind)) continue;
    const who =
      String(row.account_name ?? '').trim() ||
      String(row.person_name ?? '').trim() ||
      String(row.person_email ?? '').trim() ||
      'A customer';
    const fromStripe = String(row.source_type) === 'stripe_event';
    const shared = {
      href: milestoneEvidencePath(String(row.id)),
      observedAt: iso(row.occurred_at ?? row.created_at, now),
      reference: { type: 'product_milestone', id: String(row.id) },
      metadata: {
        milestoneKind: kind,
        sourceType: String(row.source_type ?? ''),
        personId: String(row.contact_id ?? ''),
        accountId: row.account_id ? String(row.account_id) : null
      }
    };
    if (kind === 'cancelled') {
      items.push({
        id: `customer-cancelled:${String(row.id)}`,
        kind: 'customer_cancelled',
        priority: 55,
        title: `${who} cancelled`,
        detail: fromStripe
          ? 'Stripe reported the subscription ended. Review the account before any outreach.'
          : 'Your product reported a cancellation. Review the account before any outreach.',
        ...shared
      });
    } else {
      recentResults.push({
        id: `milestone:${String(row.id)}`,
        kind: 'milestone_reached',
        priority: 25,
        title: `${who} ${MILESTONE_LABELS[kind]}`,
        detail: fromStripe ? 'Observed from Stripe.' : 'Reported by your product.',
        ...shared
      });
    }
  }

  // Meetings (migration 131), read last and on their own so the queries above are
  // untouched. Upcoming: the next 48 hours. Held: ended inside the same seven-day
  // window every other result uses. In-progress meetings are neither.
  // lc-debt: each projection (upcoming, held) is capped at 50 independently; page
  // them if a workspace books more than that in a 48-hour or 7-day window.
  const meetingHorizon = new Date(now.getTime() + 48 * 3_600_000).toISOString();
  const nowIso = now.toISOString();
  const meetingSelect = `SELECT m.id,m.provider,m.origin,m.person_id,m.account_id,
                TO_CHAR(m.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS starts_at,
                TO_CHAR(m.ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ends_at,
                p.name AS person_name,p.email AS person_email,a.name AS account_name
         FROM meetings m
         JOIN contacts p ON p.workspace_id=m.workspace_id AND p.id=m.person_id
         LEFT JOIN accounts a ON a.workspace_id=m.workspace_id AND a.id=m.account_id
         WHERE m.workspace_id=? AND m.status<>'cancelled'`;
  const [upcomingRows, heldRows, meetingSettings] = await Promise.all([
    db
      .prepare(
        `${meetingSelect}
           AND m.starts_at>?::timestamptz AND m.starts_at<=?::timestamptz
         ORDER BY m.starts_at ASC,m.id ASC
         LIMIT 50`
      )
      .all<Record<string, unknown>>(workspaceId, nowIso, meetingHorizon),
    db
      .prepare(
        `${meetingSelect}
           AND m.ends_at>=?::timestamptz AND m.ends_at<=?::timestamptz
         ORDER BY m.ends_at DESC,m.id ASC
         LIMIT 50`
      )
      .all<Record<string, unknown>>(workspaceId, recentSince, nowIso),
    db
      .prepare('SELECT timezone FROM workspace_settings WHERE workspace_id=?')
      .get<{ timezone: string | null }>(workspaceId)
  ]);
  // A Cal.com booking also lands in the host's Google Calendar, so one meeting can
  // arrive as two rows. Collapse on (person, start, end) and keep the booking row.
  // lc-debt: projection-time dedupe only; link the providers at ingest (Google
  // iCalUID to Cal.com uid) so the meetings table holds one row per meeting.
  const meetingByKey = new Map<string, Record<string, unknown>>();
  for (const row of [...upcomingRows, ...heldRows]) {
    const key = `${String(row.person_id)}\u001f${String(row.starts_at)}\u001f${String(row.ends_at)}`;
    const kept = meetingByKey.get(key);
    if (!kept || (kept.origin !== 'booking' && row.origin === 'booking')) {
      meetingByKey.set(key, row);
    }
  }
  const meetingRows = [...meetingByKey.values()];
  const meetingZone = validTimeZone(meetingSettings?.timezone);
  for (const row of meetingRows) {
    const meetingId = String(row.id);
    const startsAt = String(row.starts_at);
    const endsAt = String(row.ends_at);
    const who =
      String(row.person_name ?? '').trim() || String(row.person_email ?? '').trim() || 'a contact';
    const accountName = String(row.account_name ?? '').trim();
    const label = accountName ? `${who} (${accountName})` : who;
    const metadata = {
      meetingId,
      provider: String(row.provider ?? ''),
      personId: String(row.person_id ?? ''),
      accountId: row.account_id ? String(row.account_id) : null,
      startsAt,
      endsAt
    };
    if (startsAt > nowIso) {
      items.push({
        id: `meeting-upcoming:${meetingId}`,
        kind: 'meeting_upcoming',
        priority: 25,
        title: `Meeting with ${label}`,
        detail: `Starts ${meetingTime(startsAt, meetingZone)} (${meetingZone}).`,
        // The account's research is the prep brief; without an account, the Opportunity.
        href: row.account_id ? '/research' : '/outreach/opportunities',
        observedAt: startsAt,
        reference: { type: 'meeting', id: meetingId },
        metadata
      });
    } else if (endsAt <= nowIso) {
      recentResults.push({
        id: `meeting-held:${meetingId}`,
        kind: 'meeting_held',
        priority: 25,
        title: `Met ${label}`,
        detail: `Ended ${meetingTime(endsAt, meetingZone)} (${meetingZone}).`,
        href: '/outreach/opportunities',
        observedAt: endsAt,
        reference: { type: 'meeting', id: meetingId },
        metadata
      });
    }
  }
  return {
    needsAttention: sortAttention(items),
    working: sortAttention(working),
    recentResults: sortRecent(recentResults)
  };
}
