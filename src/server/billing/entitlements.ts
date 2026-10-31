import type { Db } from '../db.js';
import {
  getBillingClient,
  type BillingApi,
  type BillingCredits,
  type BillingEntitlements,
  type BillingSubscription,
  type TrevraBillingSnapshot
} from '../billing-client.js';

/**
 * TRV-057 entitlement gate: one deterministic answer to
 * `can(workspace, entitlementKey, quantity)` from the workspace's Billing
 * snapshot.
 *
 * WHAT BILLING ACTUALLY DEFINES FOR TREVRA. The catalog (Billing
 * `catalog/trevra.yaml`) gives each plan a set of boolean capabilities
 * (`research`, `opportunity_ranking`, `outreach_prepare`, `approval_gate`,
 * `campaigns`, `workflows`, `team`, `advanced_controls`, `priority_support`)
 * plus a monthly credit grant. OpenMeter's effective capability snapshot is
 * served by `GET /v1/trevra/customers/{id}/entitlements` as
 * `{ features: { <key>: <static config> } }`; the credit position by
 * `GET .../credits`. The gate enforces only those:
 *
 *   campaigns        -> campaigns that may be RUNNING at once
 *   outreach_prepare -> LinkedIn accounts (seats) that may be connected
 *   team             -> workspace members + pending invitations
 *                       (absent capability = the owner alone, i.e. 1)
 *   credits          -> available credit balance
 *
 * A present capability with `{}` config is unlimited. If Billing's static
 * config for a capability carries a finite, non-negative numeric `limit`, that
 * number is the cap. No Trevra plan sets one today, so the numeric path is
 * dormant until the catalog does; it is the only reading of the free-form
 * config this module performs.
 *
 * The gate only ever blocks NEW expansion. It is called at the write paths that
 * add a running campaign, a seat, a teammate or raise volume, never on reads
 * and never on already-approved, in-flight work. Nothing is ever deleted when
 * a workspace is over a limit.
 *
 * Billing not configured (self-host, dev, tests without a fake): the view is
 * `unmetered` and every check is allowed -- exactly the pre-TRV-057 behavior.
 */

/** A cached snapshot younger than this is used without asking Billing again. */
export const BILLING_FRESH_MS = 60_000;
/** How long a cached snapshot keeps answering while Billing is unreachable. */
export const BILLING_GRACE_MS = 72 * 60 * 60_000;
export const BILLING_URL = '/setup/billing';

export const ENTITLEMENT_KEYS = ['campaigns', 'outreach_prepare', 'team', 'credits'] as const;
export type EntitlementKey = (typeof ENTITLEMENT_KEYS)[number];
export type CountedEntitlementKey = Exclude<EntitlementKey, 'credits'>;
export const COUNTED_ENTITLEMENT_KEYS: readonly CountedEntitlementKey[] = [
  'campaigns',
  'outreach_prepare',
  'team'
];

const RESOURCE: Record<EntitlementKey, { label: string; noun: string }> = {
  campaigns: { label: 'Running campaigns', noun: 'campaign activations' },
  outreach_prepare: { label: 'Connected LinkedIn accounts', noun: 'LinkedIn accounts' },
  team: { label: 'Members and pending invitations', noun: 'teammates' },
  credits: { label: 'Credits', noun: 'credit-consuming changes' }
};

export function entitlementLabel(key: EntitlementKey): string {
  return RESOURCE[key].label;
}

/**
 * The snapshot as Trevra stores it: Billing's own response minus the billing
 * e-mail, Stripe identifiers and invoice ids, none of which the gate or the UI
 * needs.
 */
export type StoredBillingSnapshot = {
  customer: { plan_code: string | null; currency: string; has_payment_profile: boolean };
  subscription: Omit<
    BillingSubscription,
    'stripe_subscription_id' | 'latest_invoice_id' | 'verified_paid_invoice_id'
  >;
  credits: BillingCredits;
  entitlements: BillingEntitlements;
};

export function normalizeBillingSnapshot(snapshot: TrevraBillingSnapshot): StoredBillingSnapshot {
  const {
    stripe_subscription_id: _subscriptionId,
    latest_invoice_id: _invoice,
    verified_paid_invoice_id: _paidInvoice,
    ...subscription
  } = snapshot.subscription;
  return {
    customer: {
      plan_code: snapshot.customer.plan_code,
      currency: snapshot.customer.currency,
      has_payment_profile: Boolean(snapshot.customer.stripe_customer_id)
    },
    subscription,
    credits: snapshot.credits,
    entitlements: { features: snapshot.entitlements?.features ?? {} }
  };
}

export type EntitlementView =
  | { mode: 'unmetered' }
  | {
      mode: 'metered';
      snapshot: StoredBillingSnapshot | null;
      fetchedAt: Date | null;
      /** The last refresh failed; `snapshot` is the cached copy. */
      stale: boolean;
      withinGrace: boolean;
      graceEndsAt: Date | null;
      now: Date;
    };

export type EntitlementDenialCode =
  | 'billing_unavailable'
  | 'trial_expired'
  | 'payment_required'
  | 'not_included'
  | 'limit_reached'
  | 'insufficient_credits';

export type EntitlementDecision =
  | { allowed: true; key: EntitlementKey; quantity: number; limit: number | null }
  | {
      allowed: false;
      key: EntitlementKey;
      quantity: number;
      limit: number | null;
      code: EntitlementDenialCode;
      reason: string;
    };

export type DeniedEntitlementDecision = Extract<EntitlementDecision, { allowed: false }>;

export class EntitlementDeniedError extends Error {
  readonly status = 402;
  readonly code = 'entitlement_denied';

  constructor(
    readonly decision: DeniedEntitlementDecision,
    readonly used: number | null = null
  ) {
    super(decision.reason);
    this.name = 'EntitlementDeniedError';
  }

  body() {
    return {
      error: this.message,
      code: this.code,
      reason: this.decision.code,
      entitlement: this.decision.key,
      limit: this.decision.limit,
      used: this.used,
      billingUrl: BILLING_URL
    };
  }
}

/** Subscription states in which Billing itself says new paid work is not authorized. */
const PAYMENT_BLOCKED_STATUSES = new Set(['past_due', 'unpaid', 'incomplete', 'paused']);

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export type TrialState = { active: boolean; expired: boolean; endsAt: string | null };

/**
 * Billing has no trial-start API; it only mirrors a Stripe `trialing`
 * subscription. When it reports one, the trial ends at the mirrored period
 * end. A trial's capabilities never outlive that date, even from a cached
 * snapshot: once it passes, expansions are blocked and data is untouched.
 */
export function trialState(snapshot: StoredBillingSnapshot | null, now: Date): TrialState | null {
  if (!snapshot || snapshot.subscription.status !== 'trialing') return null;
  const end = parseDate(snapshot.subscription.current_period_end);
  const expired = end !== null && end.getTime() <= now.getTime();
  return { active: !expired, expired, endsAt: end?.toISOString() ?? null };
}

/** The cap a feature map implies for `key`. `null` means unlimited. */
export function limitFromFeatures(
  features: Record<string, Record<string, unknown>> | undefined,
  key: CountedEntitlementKey
): number | null {
  const config = features?.[key];
  if (!config) return key === 'team' ? 1 : 0;
  const limit = (config as { limit?: unknown }).limit;
  return typeof limit === 'number' && Number.isFinite(limit) && limit >= 0
    ? Math.floor(limit)
    : null;
}

export function entitlementLimit(
  snapshot: StoredBillingSnapshot,
  key: EntitlementKey
): number | null {
  if (key === 'credits') {
    const available = Number(snapshot.credits.available);
    return Number.isFinite(available) ? available : 0;
  }
  return limitFromFeatures(snapshot.entitlements.features, key);
}

function deny(
  key: EntitlementKey,
  quantity: number,
  limit: number | null,
  code: EntitlementDenialCode,
  reason: string
): DeniedEntitlementDecision {
  return { allowed: false, key, quantity, limit, code, reason };
}

/**
 * Whether the workspace may have `quantity` of `key` in use after the write
 * being attempted (for `credits`: whether `quantity` credits are available).
 * Exactly at the limit is allowed; one past it is not.
 */
export function can(
  view: EntitlementView,
  key: EntitlementKey,
  quantity: number
): EntitlementDecision {
  if (view.mode === 'unmetered') return { allowed: true, key, quantity, limit: null };
  const noun = RESOURCE[key].noun;
  const snapshot = view.snapshot;
  if (!snapshot || !view.withinGrace) {
    const since = view.fetchedAt ? ` since ${isoDay(view.fetchedAt)}` : '';
    return deny(
      key,
      quantity,
      null,
      'billing_unavailable',
      `Trevra could not confirm this workspace's plan with Billing${since}. Existing work keeps running, but new ${noun} are paused until Billing is reachable again.`
    );
  }
  const trial = trialState(snapshot, view.now);
  if (trial?.expired) {
    const ended = trial.endsAt ? ` on ${trial.endsAt.slice(0, 10)}` : '';
    return deny(
      key,
      quantity,
      null,
      'trial_expired',
      `The trial ended${ended}. Your data and running work are kept; choose a plan to add new ${noun}.`
    );
  }
  if (PAYMENT_BLOCKED_STATUSES.has(snapshot.subscription.status)) {
    return deny(
      key,
      quantity,
      null,
      'payment_required',
      `The subscription payment needs attention (${snapshot.subscription.status.replace(/_/g, ' ')}). Existing work keeps running; resolve the payment in Billing to add new ${noun}.`
    );
  }
  const limit = entitlementLimit(snapshot, key);
  if (limit === null || quantity <= limit) return { allowed: true, key, quantity, limit };
  if (key === 'credits') {
    return deny(
      key,
      quantity,
      limit,
      'insufficient_credits',
      `This workspace has ${Math.max(0, limit)} credits available and this needs ${quantity}. Existing work keeps running; credits renew with the plan.`
    );
  }
  if (limit === 0) {
    return deny(
      key,
      quantity,
      limit,
      'not_included',
      `The current plan does not include ${noun}. Nothing was changed; upgrade the plan to add them.`
    );
  }
  return deny(
    key,
    quantity,
    limit,
    'limit_reached',
    `${RESOURCE[key].label}: the current plan allows ${limit}. Nothing was deleted; get back under the limit or upgrade the plan to add more.`
  );
}

/**
 * The account-level reason every expansion is blocked right now (Billing
 * unreachable past grace, trial ended, payment needs attention), or null.
 * Per-resource limits are reported separately by `entitlementUsage`.
 */
export function accountBlock(
  view: EntitlementView
): { code: EntitlementDenialCode; reason: string } | null {
  // A zero-quantity team check can only fail for account-level reasons: the
  // team limit is never below 1.
  const decision = can(view, 'team', 0);
  return decision.allowed ? null : { code: decision.code, reason: decision.reason };
}

/** After a failed refresh, requests serve the cache for this long before asking Billing again. */
const BILLING_RETRY_AFTER_FAILURE_MS = 30_000;

type StateRow = {
  snapshot_json: StoredBillingSnapshot;
  fetched_at: string | Date;
  last_attempt_at: string | Date | null;
  last_error: string | null;
};

async function readState(db: Db, workspaceId: string): Promise<StateRow | undefined> {
  return db
    .prepare(
      'SELECT snapshot_json,fetched_at,last_attempt_at,last_error FROM billing_workspace_state WHERE workspace_id=?'
    )
    .get<StateRow>(workspaceId);
}

function meteredView(
  row: { snapshot: StoredBillingSnapshot; fetchedAt: Date } | null,
  stale: boolean,
  now: Date
): EntitlementView {
  if (!row)
    return {
      mode: 'metered',
      snapshot: null,
      fetchedAt: null,
      stale,
      withinGrace: false,
      graceEndsAt: null,
      now
    };
  const graceEndsAt = new Date(row.fetchedAt.getTime() + BILLING_GRACE_MS);
  return {
    mode: 'metered',
    snapshot: row.snapshot,
    fetchedAt: row.fetchedAt,
    stale,
    withinGrace: now.getTime() <= graceEndsAt.getTime(),
    graceEndsAt,
    now
  };
}

function fromRow(row: StateRow | undefined) {
  return row ? { snapshot: row.snapshot_json, fetchedAt: new Date(row.fetched_at) } : null;
}

function safeBillingError(error: unknown): string {
  const status = (error as { status?: unknown })?.status;
  return typeof status === 'number'
    ? `Billing request failed (${status})`
    : 'Billing could not be reached';
}

/**
 * The workspace's entitlement view. Uses the Postgres cache when it is fresh,
 * otherwise asks Billing and caches the answer; when Billing fails, falls back
 * to the cache and marks it stale. Never call this inside a transaction: it
 * may perform network I/O.
 */
export async function loadEntitlements(
  db: Db,
  workspaceId: string,
  options: { now?: Date; client?: BillingApi | null; refresh?: 'auto' | 'force' } = {}
): Promise<EntitlementView> {
  const client = options.client === undefined ? getBillingClient() : options.client;
  if (!client) return { mode: 'unmetered' };
  const now = options.now ?? new Date();
  const row = await readState(db, workspaceId);
  const cached = fromRow(row);
  if (options.refresh !== 'force' && cached) {
    if (now.getTime() - cached.fetchedAt.getTime() < BILLING_FRESH_MS)
      return meteredView(cached, false, now);
    // During an outage, do not make every expansion request wait on Billing's
    // timeouts: serve the cache (still bounded by the grace window) for a
    // short back-off after the last failure.
    const lastAttempt = row?.last_attempt_at ? new Date(row.last_attempt_at) : null;
    if (
      row?.last_error &&
      lastAttempt &&
      now.getTime() - lastAttempt.getTime() < BILLING_RETRY_AFTER_FAILURE_MS
    )
      return meteredView(cached, true, now);
  }
  const workspace = await db
    .prepare('SELECT name FROM workspaces WHERE id=?')
    .get<{ name: string }>(workspaceId);
  if (!workspace) return meteredView(cached, true, now);

  let snapshot: StoredBillingSnapshot;
  try {
    snapshot = normalizeBillingSnapshot(
      await client.workspaceSnapshot({ workspaceId, name: workspace.name, currency: 'USD' })
    );
  } catch (error) {
    await db
      .prepare(
        'UPDATE billing_workspace_state SET last_attempt_at=?,last_error=?,updated_at=? WHERE workspace_id=?'
      )
      .run(now.toISOString(), safeBillingError(error), now.toISOString(), workspaceId);
    return meteredView(cached, true, now);
  }
  // Monotonic: a slow refresh that finishes after a newer one never rolls the
  // cache back.
  await db
    .prepare(
      `INSERT INTO billing_workspace_state
         (workspace_id,snapshot_json,fetched_at,last_attempt_at,last_error,created_at,updated_at)
       VALUES (?,?::jsonb,?,?,NULL,?,?)
       ON CONFLICT (workspace_id) DO UPDATE SET
         snapshot_json=excluded.snapshot_json,
         fetched_at=excluded.fetched_at,
         last_attempt_at=excluded.last_attempt_at,
         last_error=NULL,
         updated_at=excluded.updated_at
       WHERE billing_workspace_state.fetched_at <= excluded.fetched_at`
    )
    .run(
      workspaceId,
      JSON.stringify(snapshot),
      now.toISOString(),
      now.toISOString(),
      now.toISOString(),
      now.toISOString()
    );
  return meteredView({ snapshot, fetchedAt: now }, false, now);
}

/** `can` against a freshly loaded view. Outside any transaction only. */
export async function canWorkspace(
  db: Db,
  workspaceId: string,
  key: EntitlementKey,
  quantity: number,
  options: { now?: Date; client?: BillingApi | null } = {}
): Promise<EntitlementDecision> {
  return can(await loadEntitlements(db, workspaceId, options), key, quantity);
}

function isUndefinedTable(error: unknown): boolean {
  return (error as { code?: string })?.code === '42P01';
}

/**
 * How much of a counted entitlement the workspace uses right now. Reads only
 * this workspace's rows. `team` counts Better Auth members plus unexpired
 * pending invitations unless `pendingInvitations: false`.
 */
export async function countEntitlementUsage(
  db: Db,
  workspaceId: string,
  key: CountedEntitlementKey,
  options: { pendingInvitations?: boolean; now?: Date } = {}
): Promise<number> {
  if (key === 'campaigns') {
    const row = await db
      .prepare(
        "SELECT COUNT(*)::int AS total FROM linkedin_campaigns WHERE workspace_id=? AND status='running'"
      )
      .get<{ total: number }>(workspaceId);
    return row?.total ?? 0;
  }
  if (key === 'outreach_prepare') {
    const row = await db
      .prepare('SELECT COUNT(*)::int AS total FROM linkedin_seats WHERE workspace_id=?')
      .get<{ total: number }>(workspaceId);
    return row?.total ?? 0;
  }
  // Better Auth owns member/invitation and creates them outside our
  // migrations; a database without them is a pre-organization single-owner
  // workspace.
  try {
    const members = await db
      .prepare('SELECT COUNT(*)::int AS total FROM member WHERE "organizationId"=?')
      .get<{ total: number }>(workspaceId);
    let total = members?.total ?? 0;
    if (options.pendingInvitations !== false) {
      const pending = await db
        .prepare(
          `SELECT COUNT(*)::int AS total FROM invitation
           WHERE "organizationId"=? AND status='pending' AND "expiresAt" > ?`
        )
        .get<{ total: number }>(workspaceId, (options.now ?? new Date()).toISOString());
      total += pending?.total ?? 0;
    }
    return total;
  } catch (error) {
    if (isUndefinedTable(error)) return 1;
    throw error;
  }
}

/**
 * Serializes every writer of one counted entitlement in one workspace. Taken
 * inside the write's own transaction, before the count, so two concurrent
 * expansions at the limit cannot both see room.
 */
export async function lockEntitlement(
  tx: Db,
  workspaceId: string,
  key: CountedEntitlementKey
): Promise<void> {
  await tx
    .prepare('SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0))')
    .get(`${workspaceId}:billing-entitlement:${key}`);
}

/**
 * Count-under-lock check for adding `adding` units of `key`. Pass `lock:false`
 * only where the caller already holds the lock or cannot hold one (Better
 * Auth hooks, which run on another connection).
 */
export async function assertEntitlement(
  tx: Db,
  view: EntitlementView,
  workspaceId: string,
  key: CountedEntitlementKey,
  options: { adding: number; lock?: boolean; pendingInvitations?: boolean }
): Promise<void> {
  if (view.mode === 'unmetered') return;
  if (options.lock !== false) await lockEntitlement(tx, workspaceId, key);
  const used = await countEntitlementUsage(tx, workspaceId, key, {
    pendingInvitations: options.pendingInvitations,
    now: view.now
  });
  const decision = can(view, key, used + options.adding);
  if (!decision.allowed) throw new EntitlementDeniedError(decision, used);
}

export function assertCredits(view: EntitlementView, amount: number): void {
  const decision = can(view, 'credits', amount);
  if (!decision.allowed) throw new EntitlementDeniedError(decision, null);
}

export type EntitlementUsageLine = {
  key: CountedEntitlementKey;
  label: string;
  used: number;
  /** `null` = unlimited, `0` = not included in the plan. */
  limit: number | null;
  over: boolean;
};

/** Usage against limits for the billing screen and the downgrade preview. */
export async function entitlementUsage(
  db: Db,
  workspaceId: string,
  features: Record<string, Record<string, unknown>>,
  now: Date = new Date()
): Promise<EntitlementUsageLine[]> {
  const counts = await Promise.all(
    COUNTED_ENTITLEMENT_KEYS.map((key) => countEntitlementUsage(db, workspaceId, key, { now }))
  );
  return COUNTED_ENTITLEMENT_KEYS.map((key, index) => {
    const used = counts[index] ?? 0;
    const limit = limitFromFeatures(features, key);
    return { key, label: RESOURCE[key].label, used, limit, over: limit !== null && used > limit };
  });
}

/** The same usage lines judged against another plan's capabilities (downgrade preview). */
export function usageAgainstCapabilities(
  lines: EntitlementUsageLine[],
  capabilities: Record<string, Record<string, unknown>>
): EntitlementUsageLine[] {
  return lines.map((line) => {
    const limit = limitFromFeatures(capabilities, line.key);
    return { ...line, limit, over: limit !== null && line.used > limit };
  });
}
