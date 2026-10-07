import { z } from 'zod';
import type { Db } from '../db.js';
import { appendDomainEvent } from '../control-plane/events.js';
import { ingestOutcome, skipAction } from './action-ledger.js';
import { profileUrlFor } from './driver.js';
import { LinkedInApiError } from './errors.js';
import { gateVerdict, type NextDueRow } from './execution-state.js';
import type { LinkedInSafetyOptions } from './guard.js';
import {
  KINDS_REQUIRING_BODY,
  advanceManagedMemberAfterSettledLinkedInAction,
  postgresLocalWorkerStore,
  type DueLinkedInAction,
  type ExecutableKind,
  type LocalWorkerStore
} from './local-worker.js';
import { HUMAN_SEND_KINDS, isHumanSendKind, type HumanSendKind } from './seats.js';

/* ---------------------------------------------------------------------------
 * HUMAN-SEND HANDOFFS.
 *
 * A seat in human-send mode keeps its invites and messages out of the browser
 * worker (local-worker.ts). They are still drafted, approved and gated exactly
 * like automated ones; this module hands the founder the ONE row the worker
 * would have taken next, and only once the safety gate would let it go. The
 * founder sends it on LinkedIn and reports back. Nothing here ever sends.
 * ------------------------------------------------------------------------ */

// lc-debt: ceiling of ten candidate rows per human seat per Today read, and
// one handoff per seat; upgrade path is a cursor over the claim order if a
// founder ever needs more than one queued send at a time.
const CANDIDATES_PER_SEAT = 10;
const UTC_ISO_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const HUMAN_SEND_KIND_LIST = HUMAN_SEND_KINDS.map((kind) => `'${kind}'`).join(', ');
const BODY_REQUIRED_LIST = KINDS_REQUIRING_BODY.map((kind) => `'${kind}'`).join(', ');

export interface LinkedInHandoff {
  actionId: string;
  seatKey: string;
  seatLabel: string;
  kind: HumanSendKind;
  targetRef: string;
  /** A LinkedIn URL the founder can open, or null when the target is not one. */
  targetUrl: string | null;
  /** The approved bytes to paste. Null for an invite sent without a note. */
  copyText: string | null;
  subject: string | null;
  plannedFor: string;
  campaignId: string | null;
  campaignName: string | null;
}

interface HandoffRow extends NextDueRow {
  body: string | null;
  subject: string | null;
  thread_urn: string | null;
  workflow_step_id: string | null;
  seat_label: string;
  campaign_name: string | null;
}

function dueActionOf(workspaceId: string, row: HandoffRow): DueLinkedInAction {
  return {
    id: row.id,
    workspaceId,
    seatKey: row.seat_key,
    kind: row.kind as ExecutableKind,
    targetRef: row.target_ref,
    plannedFor: row.planned_for,
    body: row.body,
    subject: row.subject,
    threadUrn: row.thread_urn,
    campaignId: row.campaign_id,
    workflowStepId: row.workflow_step_id,
    replayScope: row.replay_scope ?? 'legacy',
    overrideWarmupCeiling: row.override_warmup_ceiling === true,
    replyToInbound: row.reply_to_inbound === true,
    manual: row.source === 'manual'
  };
}

export function handoffTitle(kind: string, seatLabel: string): string {
  if (kind === 'invite') return `Send a LinkedIn invite from ${seatLabel}`;
  if (kind === 'reply') return `Send a LinkedIn reply from ${seatLabel}`;
  if (kind === 'inmail') return `Send an InMail from ${seatLabel}`;
  return `Send a LinkedIn message from ${seatLabel}`;
}

/**
 * The next send per human-send seat that the worker would take and the gate
 * would allow. Same predicates and order as the claim (`claimNextDueAction`)
 * and the campaign preview (`execution-state.ts`), restricted to the kinds a
 * founder sends by hand.
 */
export async function listLinkedInHandoffs(
  db: Db,
  workspaceId: string,
  now: Date,
  options: Pick<LinkedInSafetyOptions, 'dayShape'> = {}
): Promise<LinkedInHandoff[]> {
  const nowIso = now.toISOString();
  const rows = await db
    .prepare(
      `
      SELECT * FROM (
        SELECT a.id, a.seat_key, a.kind, a.target_ref,
               TO_CHAR(a.planned_for AT TIME ZONE 'UTC', ${UTC_ISO_FORMAT}) AS planned_for,
               a.campaign_id, a.replay_scope, a.override_warmup_ceiling, a.reply_to_inbound, a.source,
               a.body, a.subject, a.thread_urn, a.workflow_step_id,
               s.label AS seat_label, c.name AS campaign_name,
               ROW_NUMBER() OVER (
                 PARTITION BY a.seat_key
                 ORDER BY
                   (CASE WHEN a.sla_deadline_at IS NOT NULL AND a.sla_deadline_at <= ?::timestamptz THEN 1 ELSE 0 END) DESC,
                   a.queue_priority DESC,
                   a.planned_for ASC,
                   a.id ASC
               ) AS seat_rank
        FROM linkedin_actions a
        JOIN linkedin_seats s
          ON s.workspace_id = a.workspace_id AND s.seat_key = a.seat_key AND s.send_mode = 'human'
        LEFT JOIN linkedin_campaigns c
          ON c.workspace_id = a.workspace_id AND c.id = a.campaign_id
        WHERE a.workspace_id = ? AND a.status = 'planned' AND a.claimed_at IS NULL
          AND a.settlement_hold_at IS NULL
          AND a.planned_for IS NOT NULL AND a.planned_for <= ?::timestamptz
          AND a.kind IN (${HUMAN_SEND_KIND_LIST})
          AND a.target_ref IS NOT NULL
          AND (a.kind NOT IN (${BODY_REQUIRED_LIST}) OR (a.body IS NOT NULL AND a.body <> ''))
          AND (a.kind <> 'reply' OR (a.thread_urn IS NOT NULL AND a.thread_urn <> ''))
      ) ranked
      WHERE ranked.seat_rank <= ?::int
      ORDER BY ranked.seat_key ASC, ranked.seat_rank ASC
    `
    )
    .all<HandoffRow>(nowIso, workspaceId, nowIso, CANDIDATES_PER_SEAT);

  const stores = new Map<string, LocalWorkerStore>();
  const handed = new Set<string>();
  const handoffs: LinkedInHandoff[] = [];
  for (const row of rows) {
    if (handed.has(row.seat_key) || !isHumanSendKind(row.kind)) continue;
    let store = stores.get(row.seat_key);
    if (!store) {
      store = postgresLocalWorkerStore(db, workspaceId, row.seat_key);
      stores.set(row.seat_key, store);
    }
    const action = dueActionOf(workspaceId, row);
    // The worker's own pre-send questions, so a handoff is never a row the
    // worker would have retired, deferred or branch-skipped.
    if ((await store.actionExecutionState(action, { handoff: true })) !== 'execute') continue;
    const branch = await store.branchDecision(action, now);
    if (branch && branch.outcome !== 'due') continue;
    const gate = await gateVerdict(db, workspaceId, row, now, options);
    if (!gate?.allowed) continue;
    handed.add(row.seat_key);
    handoffs.push({
      actionId: row.id,
      seatKey: row.seat_key,
      seatLabel: row.seat_label,
      kind: row.kind,
      targetRef: row.target_ref,
      targetUrl: profileUrlFor(row.target_ref),
      copyText: row.body && row.body.trim() ? row.body : null,
      subject: row.subject && row.subject.trim() ? row.subject : null,
      plannedFor: row.planned_for,
      campaignId: row.campaign_id,
      campaignName: row.campaign_name
    });
  }
  return handoffs;
}

export const handoffResolutionSchema = z.object({ resolution: z.enum(['sent', 'skip']) }).strict();

/**
 * The founder's report on one handoff. 'sent' is an OUTCOME REPORT through
 * `ingestOutcome` -- the same sanctioned path as POST /api/linkedin/actions/
 * outcome -- so `recorded_at` is stamped and every safety window counts it.
 * Idempotent per target status; anything that is no longer a waiting handoff
 * is refused rather than overwritten.
 */
export async function resolveLinkedInHandoff(
  db: Db,
  input: {
    workspaceId: string;
    actionId: string;
    resolution: 'sent' | 'skip';
    actorUserId: string | null;
  },
  now: Date
): Promise<{ actionId: string; status: 'sent' | 'skipped' }> {
  const target = input.resolution === 'sent' ? 'sent' : 'skipped';
  return db.transaction(async (tx) => {
    const row = await tx
      .prepare(
        `SELECT a.id, a.kind, a.status, a.claimed_at, a.settlement_hold_at,
                (a.planned_for IS NOT NULL AND a.planned_for <= ?::timestamptz) AS due,
                s.send_mode
         FROM linkedin_actions a
         LEFT JOIN linkedin_seats s ON s.workspace_id = a.workspace_id AND s.seat_key = a.seat_key
         WHERE a.workspace_id = ? AND a.id = ?
         FOR UPDATE OF a`
      )
      .get<{
        id: string;
        kind: string;
        status: string;
        claimed_at: unknown;
        settlement_hold_at: unknown;
        due: boolean;
        send_mode: string | null;
      }>(now.toISOString(), input.workspaceId, input.actionId);
    if (!row) throw new LinkedInApiError('LinkedIn action not found', 404);
    if (row.status === target) return { actionId: row.id, status: target };
    // A 'sent' report is an outcome report: the founder already sent it, so it
    // must be recordable whatever the seat's send mode is now (otherwise a
    // switch back to automatic would let the worker send it a second time).
    // 'skip' is an instruction to Trevra and stays human-send only.
    if (!isHumanSendKind(row.kind) || (target === 'skipped' && row.send_mode !== 'human'))
      throw new LinkedInApiError(
        'Only an invite or message waiting on a human-send LinkedIn account can be resolved here.',
        409
      );
    if (
      (row.status !== 'planned' && !(target === 'sent' && row.status === 'held')) ||
      row.claimed_at !== null ||
      row.settlement_hold_at !== null ||
      row.due !== true
    )
      throw new LinkedInApiError(
        `This ${row.kind} is not waiting for you (it is '${row.status}'), so it cannot be marked ${target}.`,
        409
      );

    if (target === 'sent')
      await ingestOutcome(
        tx,
        { workspaceId: input.workspaceId, actionId: row.id, outcome: 'sent' },
        now
      );
    else await skipAction(tx, input.workspaceId, row.id, now);
    // Exactly what the worker does after settleSent / settleBranchSkipped, so
    // a managed campaign member moves on whichever way the founder answered.
    await advanceManagedMemberAfterSettledLinkedInAction(tx, input.workspaceId, row.id, now);
    await appendDomainEvent(tx, {
      workspaceId: input.workspaceId,
      streamType: 'linkedin_action',
      streamId: row.id,
      eventType: target === 'sent' ? 'linkedin.handoff.marked_sent' : 'linkedin.handoff.skipped',
      actorType: 'user',
      actorId: input.actorUserId,
      payload: { kind: row.kind },
      occurredAt: now
    });
    return { actionId: row.id, status: target };
  });
}

/**
 * Switching a seat back to automatic while a handoff waits would let the
 * worker send the row the founder may already have sent by hand.
 */
// lc-debt: check-then-upsert is not atomic, so a handoff that appears between
// the check and the seat write is not guarded; upgrade path is taking the seat
// row lock in one transaction.
export async function assertNoWaitingHandoff(
  db: Db,
  workspaceId: string,
  seatKey: string,
  now: Date,
  options: Pick<LinkedInSafetyOptions, 'dayShape'> = {}
): Promise<void> {
  const handoffs = await listLinkedInHandoffs(db, workspaceId, now, options);
  if (handoffs.some((handoff) => handoff.seatKey === seatKey))
    throw new LinkedInApiError(
      'A LinkedIn handoff is waiting in Today for this account. Mark it sent or skip it before switching back to automatic sending.',
      409
    );
}
