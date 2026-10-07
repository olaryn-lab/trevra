import { id, type Db } from './db.js';
import { appendDomainEvent } from './control-plane/events.js';
import type { OpportunityStage } from './opportunities.js';

/**
 * Forward-only Opportunity stage moves from observed facts (GTM roadmap
 * contract 1). A product milestone, a payment or a meeting can raise a stage;
 * nothing observed ever lowers one, reopens a closed row, or closes as lost.
 */
export const STAGE_RANK: Record<OpportunityStage, number> = {
  new: 1,
  qualified: 2,
  meeting: 3,
  proposal: 4,
  won: 5,
  lost: 6
};

export interface AdvanceOpportunityInput {
  workspaceId: string;
  personId: string | null;
  accountId: string | null;
  minimumStage: Exclude<OpportunityStage, 'lost'>;
  /** Used only when a new Opportunity is created. */
  title: string;
  /** Short and content-free; stored in the domain event. */
  reason: string;
  /** e.g. 'product_milestone' | 'meeting'. The pair is the idempotency key. */
  sourceType: string;
  sourceId: string;
  /** Default true. False is a pure observation; see `AdvanceOpportunityObservation`. */
  createIfMissing?: boolean;
  /** ISO instant. When set, only open Opportunities created at or before it match. */
  openedAtOrBefore?: string;
}

/**
 * `createIfMissing: false` makes the call a pure observation: with no matching
 * OPEN Opportunity it returns null and creates, closes and records nothing.
 */
export type AdvanceOpportunityObservation = AdvanceOpportunityInput & { createIfMissing: false };

export interface AdvanceOpportunityResult {
  opportunityId: string;
  previousStage: OpportunityStage | null;
  stage: OpportunityStage;
  created: boolean;
  changed: boolean;
}

export class OpportunityAdvanceError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
  }
}

type StageRow = { id: string; stage: OpportunityStage };

async function latestOpportunity(
  tx: Db,
  workspaceId: string,
  column: 'person_id' | 'account_id',
  value: string,
  open: boolean,
  openedAtOrBefore: string | null = null
): Promise<StageRow | null> {
  const bounded = open && openedAtOrBefore !== null;
  // `column` comes from a closed two-member union, never from input.
  const row = await tx
    .prepare(
      `SELECT id,stage FROM opportunities
       WHERE workspace_id=? AND ${column}=?
         AND stage ${open ? "NOT IN ('won','lost')" : "IN ('won','lost')"}${bounded ? ' AND created_at<=?::timestamptz' : ''}
       ORDER BY updated_at DESC,id DESC
       LIMIT 1${open ? ' FOR UPDATE' : ''}`
    )
    .get<StageRow>(...(bounded ? [workspaceId, value, openedAtOrBefore] : [workspaceId, value]));
  return row ?? null;
}

/**
 * Raise (or create) the Opportunity an observation belongs to.
 *
 * Opens its own transaction: callers must not call it inside one.
 *
 * 1. A source already recorded returns the Opportunity's current stage with
 *    `created: false, changed: false`.
 * 2. The most recently updated open Opportunity for the Person, else the
 *    Account, is raised only if its stage ranks below `minimumStage`.
 * 3. With only closed matches, `won` returns the latest closed row unchanged;
 *    any lower floor creates a fresh row.
 * 4. With no match, a system-owned row is created at `minimumStage`.
 *
 * `createIfMissing: false` and `openedAtOrBefore` are applied inside the lock:
 * the first returns null instead of touching closed rows or creating one, the
 * second ignores open Opportunities created after the instant.
 */
export async function advanceOpportunityStage(
  db: Db,
  input: AdvanceOpportunityObservation,
  now?: Date
): Promise<AdvanceOpportunityResult | null>;
export async function advanceOpportunityStage(
  db: Db,
  input: AdvanceOpportunityInput & { createIfMissing?: true },
  now?: Date
): Promise<AdvanceOpportunityResult>;
export async function advanceOpportunityStage(
  db: Db,
  input: AdvanceOpportunityInput,
  now?: Date
): Promise<AdvanceOpportunityResult | null>;
export async function advanceOpportunityStage(
  db: Db,
  input: AdvanceOpportunityInput,
  now: Date = new Date()
): Promise<AdvanceOpportunityResult | null> {
  const createIfMissing = input.createIfMissing !== false;
  const openedAtOrBefore = input.openedAtOrBefore
    ? new Date(input.openedAtOrBefore).toISOString()
    : null;
  const personId = input.personId?.trim() || null;
  const accountId = input.accountId?.trim() || null;
  const sourceType = input.sourceType.trim();
  const sourceId = input.sourceId.trim();
  const minimumStage = input.minimumStage;
  if (!personId && !accountId)
    throw new OpportunityAdvanceError('A stage advance requires a Person or Account.');
  if (!sourceType || !sourceId)
    throw new OpportunityAdvanceError('A stage advance requires a source.');
  if ((minimumStage as string) === 'lost' || !(minimumStage in STAGE_RANK))
    throw new OpportunityAdvanceError('Observations never close an Opportunity as lost.');
  const title = input.title.trim().slice(0, 200) || 'Opportunity';
  const reason = input.reason.trim().slice(0, 120);
  const at = now.toISOString();
  const workspaceId = input.workspaceId;

  return db.transaction(async (tx) => {
    // lc-debt: one advisory lock per workspace serialises every observed stage
    // move in it; upgrade path is a per-person/per-account lock pair once
    // observation volume turns this into a queue.
    await tx
      .prepare('SELECT pg_advisory_xact_lock(hashtextextended(?,0)) AS locked')
      .get(`${workspaceId}\u001fopportunity-advance`);

    const recorded = await tx
      .prepare(
        `SELECT o.id,o.stage
         FROM opportunity_stage_observations x
         JOIN opportunities o ON o.workspace_id=x.workspace_id AND o.id=x.opportunity_id
         WHERE x.workspace_id=? AND x.source_type=? AND x.source_id=?`
      )
      .get<StageRow>(workspaceId, sourceType, sourceId);
    if (recorded)
      return {
        opportunityId: recorded.id,
        previousStage: recorded.stage,
        stage: recorded.stage,
        created: false,
        changed: false
      };

    if (personId) {
      const person = await tx
        .prepare('SELECT 1 AS present FROM contacts WHERE workspace_id=? AND id=?')
        .get(workspaceId, personId);
      if (!person) throw new OpportunityAdvanceError('Person not found in this workspace.');
    }
    if (accountId) {
      const account = await tx
        .prepare('SELECT 1 AS present FROM accounts WHERE workspace_id=? AND id=?')
        .get(workspaceId, accountId);
      if (!account) throw new OpportunityAdvanceError('Account not found in this workspace.');
    }

    let result: AdvanceOpportunityResult;
    const open =
      (personId
        ? await latestOpportunity(tx, workspaceId, 'person_id', personId, true, openedAtOrBefore)
        : null) ??
      (accountId
        ? await latestOpportunity(tx, workspaceId, 'account_id', accountId, true, openedAtOrBefore)
        : null);
    if (!open && !createIfMissing) return null;

    if (open) {
      const raise = STAGE_RANK[open.stage] < STAGE_RANK[minimumStage];
      if (raise) {
        await tx
          .prepare(
            'UPDATE opportunities SET stage=?,closed_at=?,updated_at=? WHERE workspace_id=? AND id=?'
          )
          .run(minimumStage, minimumStage === 'won' ? at : null, at, workspaceId, open.id);
        await appendDomainEvent(tx, {
          workspaceId,
          streamType: 'opportunity',
          streamId: open.id,
          eventType: 'opportunity.stage_advanced',
          actorType: 'system',
          correlationId: sourceId,
          payload: { from: open.stage, to: minimumStage, reason, sourceType, sourceId },
          occurredAt: now
        });
      }
      result = {
        opportunityId: open.id,
        previousStage: open.stage,
        stage: raise ? minimumStage : open.stage,
        created: false,
        changed: raise
      };
    } else {
      const closed =
        (personId
          ? await latestOpportunity(tx, workspaceId, 'person_id', personId, false)
          : null) ??
        (accountId
          ? await latestOpportunity(tx, workspaceId, 'account_id', accountId, false)
          : null);
      if (closed && minimumStage === 'won') {
        result = {
          opportunityId: closed.id,
          previousStage: closed.stage,
          stage: closed.stage,
          created: false,
          changed: false
        };
      } else {
        const opportunityId = id('opp');
        await tx
          .prepare(
            `INSERT INTO opportunities (
               id,workspace_id,person_id,account_id,title,stage,owner_type,owner_id,
               next_action,next_action_at,created_at,updated_at,closed_at
             ) VALUES (?,?,?,?,?,?,'system',NULL,NULL,NULL,?,?,?)`
          )
          .run(
            opportunityId,
            workspaceId,
            personId,
            accountId,
            title,
            minimumStage,
            at,
            at,
            minimumStage === 'won' ? at : null
          );
        await appendDomainEvent(tx, {
          workspaceId,
          streamType: 'opportunity',
          streamId: opportunityId,
          eventType: 'opportunity.created_from_observation',
          actorType: 'system',
          correlationId: sourceId,
          payload: { stage: minimumStage, reason, sourceType, sourceId },
          occurredAt: now
        });
        result = {
          opportunityId,
          previousStage: null,
          stage: minimumStage,
          created: true,
          changed: true
        };
      }
    }

    await tx
      .prepare(
        `INSERT INTO opportunity_stage_observations
         (workspace_id,source_type,source_id,opportunity_id,previous_stage,stage,created,changed,created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        workspaceId,
        sourceType,
        sourceId,
        result.opportunityId,
        result.previousStage,
        result.stage,
        result.created,
        result.changed,
        at
      );
    return result;
  });
}
