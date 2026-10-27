import { z } from 'zod/v3';
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
 *
 * PRESENTED ROWS STAY HANDED. Once Today has shown a row to the founder
 * (`handoff_presented_at`, stamped by `presentLinkedInHandoffs`), it is that
 * seat's handoff until it is resolved, whatever the gate says on a later day:
 * the founder may already have sent it, so it must neither vanish from Today
 * nor let the seat switch back to automatic and be sent a second time.
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

const HANDOFF_COLUMNS = `a.id, a.seat_key, a.kind, a.target_ref,
               TO_CHAR(COALESCE(a.planned_for, a.handoff_presented_at) AT TIME ZONE 'UTC', ${UTC_ISO_FORMAT}) AS planned_for,
               a.campaign_id, a.replay_scope, a.override_warmup_ceiling, a.reply_to_inbound, a.source,
               a.body, a.subject, a.thread_urn, a.workflow_step_id,
               s.label AS seat_label, c.name AS campaign_name`;

function toHandoff(row: HandoffRow & { kind: HumanSendKind }): LinkedInHandoff {
  return {
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
  };
}

function storeFor(
  stores: Map<string, LocalWorkerStore>,
  db: Db,
  workspaceId: string,
  seatKey: string
): LocalWorkerStore {
  let store = stores.get(seatKey);
  if (!store) {
    store = postgresLocalWorkerStore(db, workspaceId, seatKey);
    stores.set(seatKey, store);
  }
  return store;
}

/**
 * Per human-send seat, the first PRESENTED row that is still open and that the
 * worker's own pre-send checks would not retire or branch-skip. Deliberately
 * blind to the gate and to `planned_for`: a row the founder was shown may
 * already have been sent by hand, so a weekend, a reached cap or a re-pace must
 * not hide it. This is both Today's first choice per seat and the switch guard,
 * so whenever the guard refuses, Today shows the row that blocks it.
 */
async function presentedHandoffRows(
  db: Db,
  workspaceId: string,
  now: Date,
  stores: Map<string, LocalWorkerStore>,
  seatKey?: string
): Promise<Map<string, HandoffRow & { kind: HumanSendKind }>> {
  const rows = await db
    .prepare(
      `
      SELECT ${HANDOFF_COLUMNS}
      FROM linkedin_actions a
      JOIN linkedin_seats s
        ON s.workspace_id = a.workspace_id AND s.seat_key = a.seat_key AND s.send_mode = 'human'
      LEFT JOIN linkedin_campaigns c
        ON c.workspace_id = a.workspace_id AND c.id = a.campaign_id
      WHERE a.workspace_id = ? AND a.handoff_presented_at IS NOT NULL
        AND a.status IN ('planned', 'held') AND a.claimed_at IS NULL
        AND a.settlement_hold_at IS NULL
        AND a.kind IN (${HUMAN_SEND_KIND_LIST})
        AND a.target_ref IS NOT NULL
        AND (?::text IS NULL OR a.seat_key = ?::text)
      ORDER BY a.seat_key ASC, a.handoff_presented_at ASC, a.id ASC
    `
    )
    .all<HandoffRow>(workspaceId, seatKey ?? null, seatKey ?? null);

  const chosen = new Map<string, HandoffRow & { kind: HumanSendKind }>();
  for (const row of rows) {
    if (chosen.has(row.seat_key) || !isHumanSendKind(row.kind)) continue;
    const store = storeFor(stores, db, workspaceId, row.seat_key);
    const action = dueActionOf(workspaceId, row);
    if ((await store.actionExecutionState(action, { handoff: true })) === 'retire') continue;
    const branch = await store.branchDecision(action, now);
    if (branch && branch.outcome === 'skipped') continue;
    chosen.set(row.seat_key, row as HandoffRow & { kind: HumanSendKind });
  }
  return chosen;
}

/**
 * The handoff per human-send seat. A presented, still-open row comes first
 * (see `presentedHandoffRows`); otherwise the next send the worker would take
 * and the gate would allow -- same predicates and order as the claim
 * (`claimNextDueAction`) and the campaign preview (`execution-state.ts`),
 * restricted to the kinds a founder sends by hand. Read-only: Today stamps
 * what it shows through `presentLinkedInHandoffs`.
 */
export async function listLinkedInHandoffs(
  db: Db,
  workspaceId: string,
  now: Date,
  options: Pick<LinkedInSafetyOptions, 'dayShape'> = {}
): Promise<LinkedInHandoff[]> {
  const nowIso = now.toISOString();
  const stores = new Map<string, LocalWorkerStore>();
  const presented = await presentedHandoffRows(db, workspaceId, now, stores);
  const rows = await db
    .prepare(
      `
      SELECT * FROM (
        SELECT ${HANDOFF_COLUMNS},
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

  const bySeat = new Map<string, LinkedInHandoff>();
  for (const [seatKey, row] of presented) bySeat.set(seatKey, toHandoff(row));
  for (const row of rows) {
    if (bySeat.has(row.seat_key) || !isHumanSendKind(row.kind)) continue;
    const store = storeFor(stores, db, workspaceId, row.seat_key);
    const action = dueActionOf(workspaceId, row);
    // The worker's own pre-send questions, so a handoff is never a row the
    // worker would have retired, deferred or branch-skipped.
    if ((await store.actionExecutionState(action, { handoff: true })) !== 'execute') continue;
    const branch = await store.branchDecision(action, now);
    if (branch && branch.outcome !== 'due') continue;
    const gate = await gateVerdict(db, workspaceId, row, now, options);
    if (!gate?.allowed) continue;
    bySeat.set(row.seat_key, toHandoff(row as HandoffRow & { kind: HumanSendKind }));
  }
  return [...bySeat.values()].sort((a, b) =>
    a.seatKey < b.seatKey ? -1 : a.seatKey > b.seatKey ? 1 : 0
  );
}

/**
 * Stamp the handoffs Today is about to show as presented, and return only the
 * ones that were stamped. Serialized against a switch to automatic: the seats
 * are read FOR SHARE and only rows whose seat is still human-send are stamped,
 * so a seat that flipped mid-read drops out of Today instead of leaving a
 * stamped row the worker is about to send. The first stamp is kept.
 */
export async function presentLinkedInHandoffs(
  db: Db,
  workspaceId: string,
  handoffs: readonly LinkedInHandoff[],
  now: Date
): Promise<LinkedInHandoff[]> {
  if (handoffs.length === 0) return [];
  const seatKeys = [...new Set(handoffs.map((handoff) => handoff.seatKey))].sort();
  const stamped = await db.transaction(async (tx) => {
    const human = await tx
      .prepare(
        `SELECT seat_key FROM linkedin_seats
         WHERE workspace_id = ? AND seat_key = ANY(?::text[]) AND send_mode = 'human'
         ORDER BY seat_key
         FOR SHARE`
      )
      .all<{ seat_key: string }>(workspaceId, seatKeys);
    if (human.length === 0) return new Set<string>();
    const rows = await tx
      .prepare(
        `UPDATE linkedin_actions
         SET handoff_presented_at = COALESCE(handoff_presented_at, ?::timestamptz)
         WHERE workspace_id = ? AND id = ANY(?::text[]) AND seat_key = ANY(?::text[])
           AND status IN ('planned', 'held') AND claimed_at IS NULL
           AND settlement_hold_at IS NULL
         RETURNING id`
      )
      .all<{ id: string }>(
        now.toISOString(),
        workspaceId,
        handoffs.map((handoff) => handoff.actionId),
        human.map((seat) => seat.seat_key)
      );
    return new Set(rows.map((row) => row.id));
  });
  return handoffs.filter((handoff) => stamped.has(handoff.actionId));
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
                (a.handoff_presented_at IS NOT NULL) AS presented,
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
        presented: boolean;
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
    // A row Today already presented stays answerable after a re-pace moved
    // its planned_for into the future: it may be what blocks a switch.
    if (
      (row.status !== 'planned' && !(target === 'sent' && row.status === 'held')) ||
      row.claimed_at !== null ||
      row.settlement_hold_at !== null ||
      (row.due !== true && row.presented !== true)
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
 * Switching a seat back to automatic while a PRESENTED handoff is still open
 * would let the worker send the row the founder may already have sent by
 * hand. Blind to the gate and to `planned_for` (see `presentedHandoffRows`),
 * so the answer does not change with the day of the week. Call it through
 * `guardSeatSendModeChange`, inside the transaction that writes the seat.
 */
export async function assertNoWaitingHandoff(
  db: Db,
  workspaceId: string,
  seatKey: string,
  now: Date
): Promise<void> {
  const presented = await presentedHandoffRows(db, workspaceId, now, new Map(), seatKey);
  if (presented.has(seatKey))
    throw new LinkedInApiError(
      'A LinkedIn handoff is waiting in Today for this account. Mark it sent or skip it before switching back to automatic sending.',
      409
    );
}

/**
 * Take the seat row lock, then refuse a human-to-automatic switch while a
 * presented handoff is open. `tx` MUST be the transaction that then writes
 * the seat: the FOR UPDATE here conflicts with `presentLinkedInHandoffs`'s
 * FOR SHARE, so a row cannot be presented between this check and the write.
 */
export async function guardSeatSendModeChange(
  tx: Db,
  workspaceId: string,
  seatKey: string,
  sendMode: string | undefined,
  now: Date
): Promise<void> {
  const seat = await tx
    .prepare(
      `SELECT send_mode FROM linkedin_seats WHERE workspace_id = ? AND seat_key = ? FOR UPDATE`
    )
    .get<{ send_mode: string }>(workspaceId, seatKey);
  if (sendMode !== 'automated' || seat?.send_mode !== 'human') return;
  await assertNoWaitingHandoff(tx, workspaceId, seatKey, now);
}
