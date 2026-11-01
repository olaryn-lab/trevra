import {
  BillingServiceError,
  type BillingApi,
  type BillingCheckout,
  type BillingCustomer,
  type BillingLifecycleResult,
  type BillingPlan,
  type BillingPlanPreview,
  type BillingReservation,
  type TrevraBillingSnapshot
} from '../billing-client.js';

/**
 * TEST SUPPORT ONLY (TRV-057). An in-memory stand-in for Olaryn Billing that
 * follows the semantics Trevra relies on: reservation idempotency keys are
 * unique per customer and reuse returns the same reservation, settle is
 * idempotent, an expired reservation cannot be settled, and a reservation
 * larger than the available credits is refused with 409. Nothing here is
 * imported by production code.
 */

export type FakeWorkspaceBilling = {
  planCode: string | null;
  status: string;
  features: Record<string, Record<string, unknown>>;
  available: number;
  usage: number;
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  scheduledPlanCode: string | null;
};

type FakeReservation = BillingReservation & {
  workspaceId: string;
  settleCount: number;
  expired: boolean;
};

export type FakeCall = {
  method: string;
  workspaceId?: string;
  planCode?: string;
  idempotencyKey?: string;
};

export function fakePlan(
  tier: string,
  interval: 'monthly' | 'yearly',
  capabilities: Record<string, Record<string, unknown>>
): BillingPlan {
  return {
    plan_code: `${tier}_${interval}_usd`,
    tier,
    name: tier.charAt(0).toUpperCase() + tier.slice(1),
    interval,
    currency: 'USD',
    amount: interval === 'monthly' ? 49 : 490,
    amount_cents: interval === 'monthly' ? 4900 : 49000,
    monthly_credits: 1000,
    capabilities,
    contact_required: false
  };
}

export class FakeBilling implements BillingApi {
  readonly workspaces = new Map<string, FakeWorkspaceBilling>();
  readonly reservations = new Map<string, FakeReservation>();
  readonly calls: FakeCall[] = [];
  /** When true, every snapshot read fails like an unreachable service. */
  unreachable = false;
  /** Errors thrown, in order, by the next calls of a method. */
  readonly failures = new Map<string, Error[]>();
  catalog: BillingPlan[] = [];
  private sequence = 0;

  constructor(private readonly defaults: FakeWorkspaceBilling) {}

  state(workspaceId: string): FakeWorkspaceBilling {
    let state = this.workspaces.get(workspaceId);
    if (!state) {
      state = { ...this.defaults, features: { ...this.defaults.features } };
      this.workspaces.set(workspaceId, state);
    }
    return state;
  }

  set(workspaceId: string, patch: Partial<FakeWorkspaceBilling>): void {
    Object.assign(this.state(workspaceId), patch);
  }

  failNext(method: string, error: Error): void {
    const queue = this.failures.get(method) ?? [];
    queue.push(error);
    this.failures.set(method, queue);
  }

  private maybeFail(method: string): void {
    const next = this.failures.get(method)?.shift();
    if (next) throw next;
  }

  private customer(workspaceId: string, name: string): BillingCustomer {
    const state = this.state(workspaceId);
    return {
      id: `cus_${workspaceId}`,
      product: 'trevra',
      external_customer_id: workspaceId,
      name,
      billing_email: 'billing@example.test',
      currency: 'USD',
      stripe_customer_id: state.planCode ? `cus_stripe_${workspaceId}` : null,
      plan_code: state.planCode
    };
  }

  async plans(): Promise<BillingPlan[]> {
    this.calls.push({ method: 'plans' });
    this.maybeFail('plans');
    return this.catalog;
  }

  async startPlan(input: {
    workspaceId: string;
    planCode: string;
    idempotencyKey: string;
  }): Promise<BillingCheckout> {
    this.calls.push({ method: 'startPlan', ...input });
    this.maybeFail('startPlan');
    return { status: 'checkout', url: `https://checkout.example.test/${input.idempotencyKey}` };
  }

  async ensureWorkspaceCustomer(input: {
    workspaceId: string;
    name: string;
  }): Promise<BillingCustomer> {
    this.calls.push({ method: 'ensureWorkspaceCustomer', workspaceId: input.workspaceId });
    this.maybeFail('ensureWorkspaceCustomer');
    return this.customer(input.workspaceId, input.name);
  }

  async workspaceSnapshot(input: {
    workspaceId: string;
    name: string;
  }): Promise<TrevraBillingSnapshot> {
    this.calls.push({ method: 'workspaceSnapshot', workspaceId: input.workspaceId });
    if (this.unreachable) throw new BillingServiceError('Billing request failed', 503);
    this.maybeFail('workspaceSnapshot');
    const state = this.state(input.workspaceId);
    return {
      enabled: true,
      customer: this.customer(input.workspaceId, input.name),
      subscription: {
        status: state.status,
        plan_code: state.planCode,
        scheduled_plan_code: state.scheduledPlanCode,
        stripe_subscription_id: state.planCode ? `sub_${input.workspaceId}` : null,
        current_period_start: null,
        current_period_end: state.periodEnd,
        cancel_at_period_end: state.cancelAtPeriodEnd,
        latest_invoice_id: 'in_secret',
        verified_paid_invoice_id: 'in_secret_paid'
      },
      credits: {
        balance: state.available + state.usage,
        usage: state.usage,
        available: state.available,
        period_start: null,
        period_end: state.periodEnd
      },
      entitlements: { features: state.features }
    };
  }

  async previewPlanChange(input: {
    workspaceId: string;
    planCode: string;
  }): Promise<BillingPlanPreview> {
    this.calls.push({ method: 'previewPlanChange', ...input });
    this.maybeFail('previewPlanChange');
    const state = this.state(input.workspaceId);
    return {
      change_type: 'downgrade',
      apply_immediately: false,
      amount_due: 0,
      currency: 'USD',
      current_plan_code: state.planCode,
      new_plan_code: input.planCode,
      credits_current: 1000,
      credits_new: 1000,
      credits_prorated_to_grant: 0,
      current_period_end: state.periodEnd
    };
  }

  async changePlan(input: {
    workspaceId: string;
    planCode: string;
    idempotencyKey: string;
  }): Promise<BillingLifecycleResult> {
    this.calls.push({ method: 'changePlan', ...input });
    this.maybeFail('changePlan');
    this.set(input.workspaceId, { scheduledPlanCode: input.planCode });
    return { status: 'scheduled' };
  }

  async cancelSubscription(input: {
    workspaceId: string;
    idempotencyKey: string;
  }): Promise<BillingLifecycleResult> {
    this.calls.push({ method: 'cancelSubscription', ...input });
    this.maybeFail('cancelSubscription');
    this.set(input.workspaceId, { cancelAtPeriodEnd: true });
    return { status: 'updated' };
  }

  async resumeSubscription(input: {
    workspaceId: string;
    idempotencyKey: string;
  }): Promise<BillingLifecycleResult> {
    this.calls.push({ method: 'resumeSubscription', ...input });
    this.maybeFail('resumeSubscription');
    this.set(input.workspaceId, { cancelAtPeriodEnd: false });
    return { status: 'updated' };
  }

  async reserveCredits(input: {
    workspaceId: string;
    amount: string;
    operation: string;
    idempotencyKey: string;
  }): Promise<BillingReservation> {
    this.calls.push({
      method: 'reserveCredits',
      workspaceId: input.workspaceId,
      idempotencyKey: input.idempotencyKey
    });
    this.maybeFail('reserveCredits');
    const key = `${input.workspaceId}|${input.idempotencyKey}`;
    const existing = this.reservations.get(key);
    if (existing) return existing;
    const amount = Number(input.amount);
    if (amount > this.state(input.workspaceId).available)
      throw new BillingServiceError('Insufficient credits', 409);
    this.sequence += 1;
    const reservation: FakeReservation = {
      id: `res_${this.sequence}`,
      amount,
      settled_amount: null,
      operation: input.operation,
      idempotency_key: input.idempotencyKey,
      status: 'active',
      workspaceId: input.workspaceId,
      settleCount: 0,
      expired: false
    };
    this.reservations.set(key, reservation);
    return reservation;
  }

  async settleReservation(input: {
    workspaceId: string;
    reservationId: string;
  }): Promise<BillingReservation> {
    this.calls.push({ method: 'settleReservation', workspaceId: input.workspaceId });
    this.maybeFail('settleReservation');
    const reservation = [...this.reservations.values()].find(
      (candidate) =>
        candidate.id === input.reservationId && candidate.workspaceId === input.workspaceId
    );
    if (!reservation) throw new BillingServiceError('Reservation not found', 404);
    if (reservation.status === 'settled') return reservation;
    if (reservation.expired)
      throw new BillingServiceError('Reservation expired before settlement', 409);
    reservation.status = 'settled';
    reservation.settled_amount = reservation.amount;
    reservation.settleCount += 1;
    const state = this.state(input.workspaceId);
    state.available -= Number(reservation.amount);
    state.usage += Number(reservation.amount);
    return reservation;
  }

  /** Total credits Billing counted for a workspace. */
  settledCredits(workspaceId: string): number {
    return [...this.reservations.values()]
      .filter((reservation) => reservation.workspaceId === workspaceId)
      .reduce((sum, reservation) => sum + Number(reservation.settled_amount ?? 0), 0);
  }
}
