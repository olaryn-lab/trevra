import { id, type Db } from '../db.js';
import { appendDomainEvent } from '../control-plane/events.js';
import { recordSignals } from '../accounts/sweep.js';
import { rescoreAccount } from '../accounts/score.js';
import { advanceOpportunityStage, type AdvanceOpportunityResult } from '../opportunity-advance.js';
import { LeadCaptureError } from './types.js';
import {
  MILESTONE_LABELS,
  MILESTONE_MINIMUM_STAGE,
  MILESTONE_SIGNAL_KIND,
  milestoneEvidencePath,
  milestoneKey,
  type GtmMilestoneKind,
  type MilestoneSourceType
} from './milestones.js';

export interface ProductMilestone {
  id: string;
  workspaceId: string;
  kind: GtmMilestoneKind;
  contactId: string;
  accountId: string | null;
  sourceType: MilestoneSourceType;
  sourceId: string;
  providerEndpointId: string | null;
  externalObjectId: string | null;
  occurredAt: string;
  createdAt: string;
}

export interface ProductMilestoneView extends ProductMilestone {
  label: string;
  personName: string | null;
  personEmail: string | null;
  accountName: string | null;
}

export interface RecordProductMilestoneInput {
  workspaceId: string;
  kind: GtmMilestoneKind;
  contactId: string;
  accountId: string | null;
  sourceType: MilestoneSourceType;
  sourceId: string;
  providerEndpointId?: string | null;
  externalObjectId?: string | null;
  occurredAt: Date;
}

export interface RecordProductMilestoneResult {
  milestone: ProductMilestone;
  created: boolean;
  signalsWritten: number;
  opportunity: AdvanceOpportunityResult | null;
}

function toMilestone(row: Record<string, unknown>): ProductMilestone {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    kind: String(row.kind) as GtmMilestoneKind,
    contactId: String(row.contact_id),
    accountId: row.account_id ? String(row.account_id) : null,
    sourceType: String(row.source_type) as MilestoneSourceType,
    sourceId: String(row.source_id),
    providerEndpointId: row.provider_endpoint_id ? String(row.provider_endpoint_id) : null,
    externalObjectId: row.external_object_id ? String(row.external_object_id) : null,
    occurredAt: new Date(String(row.occurred_at)).toISOString(),
    createdAt: new Date(String(row.created_at)).toISOString()
  };
}

/** A person who already paid, or whose Opportunity is won, is a customer. */
async function isCustomer(db: Db, workspaceId: string, contactId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS present
       WHERE EXISTS (SELECT 1 FROM product_milestones WHERE workspace_id=? AND contact_id=? AND kind='paid')
          OR EXISTS (SELECT 1 FROM opportunities WHERE workspace_id=? AND person_id=? AND stage='won')`
    )
    .get<{ present: number }>(workspaceId, contactId, workspaceId, contactId);
  return Boolean(row);
}

async function opportunityTitle(
  db: Db,
  workspaceId: string,
  contactId: string,
  accountId: string | null,
  kind: GtmMilestoneKind
): Promise<string> {
  const row = await db
    .prepare(
      `SELECT p.name AS person_name,a.name AS account_name
       FROM contacts p
       LEFT JOIN accounts a ON a.workspace_id=p.workspace_id AND a.id=?
       WHERE p.workspace_id=? AND p.id=?`
    )
    .get<Record<string, unknown>>(accountId, workspaceId, contactId);
  const who =
    String(row?.account_name ?? '').trim() || String(row?.person_name ?? '').trim() || 'Customer';
  return `${who}: ${kind === 'paid' ? 'paying customer' : 'product adoption'}`;
}

/**
 * THE ONLY WRITER OF PRODUCT MILESTONES. The signed intake and the Stripe
 * webhook both call it, so the two sources converge on one record.
 *
 * 1. One `product_milestones` row per deterministic key (`milestoneKey`), under
 *    an advisory lock, plus one `product_milestone.recorded` event.
 * 2. One private account signal (deduped by `milestone:<id>`), then a rescore.
 * 3. One forward-only stage move keyed by the milestone id. Adoption is skipped
 *    once the person is already a customer, so a late `activated` never opens
 *    a fresh qualified Opportunity beside a won one.
 *
 * Steps 2 and 3 run on every call, including duplicates, so a retry after a
 * crash between writes converges instead of leaving a half-recorded milestone.
 */
export async function recordProductMilestone(
  db: Db,
  input: RecordProductMilestoneInput,
  now: Date = new Date()
): Promise<RecordProductMilestoneResult> {
  const sourceId = input.sourceId.trim();
  if (!sourceId) throw new LeadCaptureError('A milestone needs a source id.', 400);
  const occurredAt =
    !Number.isFinite(input.occurredAt.getTime()) || input.occurredAt.getTime() > now.getTime()
      ? now
      : input.occurredAt;
  const externalObjectId = input.externalObjectId?.trim() || null;
  const key = milestoneKey({
    kind: input.kind,
    contactId: input.contactId,
    sourceType: input.sourceType,
    sourceId,
    externalObjectId
  });

  const { milestone, created } = await db.transaction(async (tx) => {
    await tx
      .prepare('SELECT pg_advisory_xact_lock(hashtextextended(?,0)) AS locked')
      .get(`${input.workspaceId}\u001fmilestone\u001f${key}`);
    const contact = await tx
      .prepare('SELECT 1 AS present FROM contacts WHERE workspace_id=? AND id=?')
      .get(input.workspaceId, input.contactId);
    if (!contact) throw new LeadCaptureError('Person not found in this workspace.', 400);
    if (input.accountId) {
      const account = await tx
        .prepare('SELECT 1 AS present FROM accounts WHERE workspace_id=? AND id=?')
        .get(input.workspaceId, input.accountId);
      if (!account) throw new LeadCaptureError('Account not found in this workspace.', 400);
    }

    const findExisting = () =>
      tx
        .prepare(
          `SELECT * FROM product_milestones
           WHERE workspace_id=? AND ((source_type=? AND source_id=?) OR milestone_key=?)
           ORDER BY created_at ASC,id ASC LIMIT 1`
        )
        .get<Record<string, unknown>>(input.workspaceId, input.sourceType, sourceId, key);
    const existing = await findExisting();
    if (existing) return { milestone: toMilestone(existing), created: false };

    const milestoneId = id('pm');
    const row = await tx
      .prepare(
        `INSERT INTO product_milestones (
           id,workspace_id,kind,contact_id,account_id,source_type,source_id,
           provider_endpoint_id,external_object_id,milestone_key,occurred_at,created_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT DO NOTHING
         RETURNING *`
      )
      .get<Record<string, unknown>>(
        milestoneId,
        input.workspaceId,
        input.kind,
        input.contactId,
        input.accountId,
        input.sourceType,
        sourceId,
        input.providerEndpointId ?? null,
        externalObjectId,
        key,
        occurredAt.toISOString(),
        now.toISOString()
      );
    if (!row) {
      const winner = await findExisting();
      if (!winner) throw new Error('Product milestone could not be recorded');
      return { milestone: toMilestone(winner), created: false };
    }
    await appendDomainEvent(tx, {
      workspaceId: input.workspaceId,
      streamType: 'contact',
      streamId: input.contactId,
      eventType: 'product_milestone.recorded',
      actorType: 'system',
      actorId: input.providerEndpointId ?? null,
      correlationId: milestoneId,
      payload: { kind: input.kind, sourceType: input.sourceType, milestoneId },
      occurredAt: now
    });
    return { milestone: toMilestone(row), created: true };
  });

  // lc-debt: the milestone row commits before the signal, rescore and stage move, so a crash
  // between them leaves a half-recorded milestone until the sender retries (every step is
  // idempotent and re-runs on duplicates); upgrade to a transactional outbox or a reconciler
  // sweep over milestones without a signal or stage move.
  let signalsWritten = 0;
  const accountId = input.accountId ?? milestone.accountId;
  if (accountId) {
    const written = await recordSignals(
      db,
      input.workspaceId,
      accountId,
      [
        {
          kind: MILESTONE_SIGNAL_KIND[milestone.kind],
          detail: `A person at this account ${MILESTONE_LABELS[milestone.kind]}.`,
          previous: null,
          current: `milestone:${milestone.id}`,
          evidenceUrl: milestoneEvidencePath(milestone.id),
          observedAt: new Date(milestone.occurredAt)
        }
      ],
      now
    );
    signalsWritten = written.length;
    await rescoreAccount(db, input.workspaceId, accountId, { now });
  }

  let opportunity: AdvanceOpportunityResult | null = null;
  const minimumStage = MILESTONE_MINIMUM_STAGE[milestone.kind];
  const skipAdoption =
    minimumStage !== null &&
    minimumStage !== 'won' &&
    (await isCustomer(db, input.workspaceId, milestone.contactId));
  if (minimumStage && !skipAdoption) {
    opportunity = await advanceOpportunityStage(
      db,
      {
        workspaceId: input.workspaceId,
        personId: milestone.contactId,
        accountId,
        minimumStage,
        title: await opportunityTitle(
          db,
          input.workspaceId,
          milestone.contactId,
          accountId,
          milestone.kind
        ),
        reason: `milestone:${milestone.kind}`,
        sourceType: 'product_milestone',
        sourceId: milestone.id
      },
      now
    );
  }

  return { milestone, created, signalsWritten, opportunity };
}

export async function listProductMilestones(
  db: Db,
  workspaceId: string,
  limit = 50
): Promise<ProductMilestoneView[]> {
  const rows = await db
    .prepare(
      `SELECT m.*,p.name AS person_name,p.email AS person_email,a.name AS account_name
       FROM product_milestones m
       JOIN contacts p ON p.workspace_id=m.workspace_id AND p.id=m.contact_id
       LEFT JOIN accounts a ON a.workspace_id=m.workspace_id AND a.id=m.account_id
       WHERE m.workspace_id=?
       ORDER BY m.occurred_at DESC,m.id DESC
       LIMIT ?`
    )
    .all<Record<string, unknown>>(workspaceId, Math.max(1, Math.min(limit, 200)));
  return rows.map((row) => {
    const milestone = toMilestone(row);
    return {
      ...milestone,
      label: MILESTONE_LABELS[milestone.kind],
      personName: row.person_name ? String(row.person_name) : null,
      personEmail: row.person_email ? String(row.person_email) : null,
      accountName: row.account_name ? String(row.account_name) : null
    };
  });
}
