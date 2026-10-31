export type BillingCustomer = {
  id: string;
  product: string;
  external_customer_id: string;
  name: string;
  billing_email: string | null;
  currency: string;
  stripe_customer_id: string | null;
  plan_code: string | null;
};

export type BillingSubscription = {
  status: string;
  plan_code: string | null;
  scheduled_plan_code?: string | null;
  stripe_subscription_id?: string | null;
  current_period_start?: string | null;
  current_period_end?: string | null;
  cancel_at_period_end?: boolean;
  latest_invoice_id?: string | null;
  current_period_paid?: boolean;
  current_period_payment_status?: string;
  verified_paid_invoice_id?: string | null;
  paid_through?: string | null;
  billing_source?: string;
  external_reference?: string | null;
  ends_at?: string | null;
};

export type BillingCredits = {
  balance: string | number;
  usage: string | number;
  available: string | number;
  period_start: string | null;
  period_end: string | null;
};

export type BillingEntitlements = {
  features: Record<string, Record<string, unknown>>;
};

export type BillingPlan = {
  plan_code: string;
  tier: string;
  name: string;
  interval: 'monthly' | 'yearly';
  currency: string;
  amount: string | number;
  amount_cents: number;
  monthly_credits: string | number;
  capabilities: Record<string, Record<string, unknown>>;
  contact_required: boolean;
};

export type BillingCheckout = {
  status: string;
  url: string | null;
  change_type?: string | null;
  message?: string | null;
};

/** `POST .../subscription/preview` (Billing `PlanPreviewView`). Read-only; nothing is charged. */
export type BillingPlanPreview = {
  change_type: string;
  apply_immediately: boolean;
  amount_due: number;
  currency: string;
  current_plan_code: string | null;
  new_plan_code: string;
  credits_current: string | number;
  credits_new: string | number;
  credits_prorated_to_grant: string | number;
  current_period_end?: string | null;
  unused_value_old_cents?: number;
  prorated_charge_new_cents?: number;
};

/**
 * `POST .../subscription/change|cancel|resume`. Billing returns a free-form
 * dict (`scheduled`, `updated`, `payment_pending`, `noop`, or a checkout
 * response when there is no paid subscription yet); only `status` is stable.
 */
export type BillingLifecycleResult = { status?: string; [key: string]: unknown };

/** `POST .../reservations` and `.../settle` (Billing `ReservationView`). */
export type BillingReservation = {
  id: string;
  amount: string | number;
  settled_amount: string | number | null;
  operation: string;
  idempotency_key: string;
  status: string;
};

export type TrevraBillingSnapshot = {
  enabled: true;
  customer: BillingCustomer;
  subscription: BillingSubscription;
  credits: BillingCredits;
  entitlements: BillingEntitlements;
};

/**
 * Every Billing call Trevra makes, as an interface so tests can substitute a
 * fake. Each method maps to exactly one existing Olaryn Billing route under
 * `/v1/trevra/...`; nothing here is a Trevra invention.
 */
export interface BillingApi {
  plans(): Promise<BillingPlan[]>;
  startPlan(input: {
    workspaceId: string;
    planCode: string;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
  }): Promise<BillingCheckout>;
  ensureWorkspaceCustomer(input: {
    workspaceId: string;
    name: string;
    currency?: string;
  }): Promise<BillingCustomer>;
  workspaceSnapshot(input: {
    workspaceId: string;
    name: string;
    currency?: string;
  }): Promise<TrevraBillingSnapshot>;
  previewPlanChange(input: { workspaceId: string; planCode: string }): Promise<BillingPlanPreview>;
  changePlan(input: {
    workspaceId: string;
    planCode: string;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
  }): Promise<BillingLifecycleResult>;
  cancelSubscription(input: {
    workspaceId: string;
    idempotencyKey: string;
  }): Promise<BillingLifecycleResult>;
  resumeSubscription(input: {
    workspaceId: string;
    idempotencyKey: string;
  }): Promise<BillingLifecycleResult>;
  reserveCredits(input: {
    workspaceId: string;
    amount: string;
    operation: string;
    idempotencyKey: string;
    ttlSeconds: number;
    resourceType: string;
    resourceId: string;
  }): Promise<BillingReservation>;
  settleReservation(input: {
    workspaceId: string;
    reservationId: string;
  }): Promise<BillingReservation>;
}

type FetchLike = typeof fetch;

export type BillingClientConfig = {
  baseUrl: string;
  authwardIssuer: string;
  clientId: string;
  clientSecret: string;
  audience: string;
};

type CachedToken = {
  value: string;
  expiresAt: number;
};

export class BillingServiceError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null
  ) {
    super(message);
    this.name = 'BillingServiceError';
  }
}

function configuredBilling(env: NodeJS.ProcessEnv = process.env): BillingClientConfig | null {
  const baseUrl = env.BILLING_BASE_URL?.trim().replace(/\/$/, '');
  const issuer = env.AUTHWARD_ISSUER?.trim().replace(/\/$/, '');
  const clientSecret = env.BILLING_CLIENT_SECRET?.trim();
  if (!baseUrl || !issuer || !clientSecret) return null;
  return {
    baseUrl,
    authwardIssuer: issuer,
    clientId: env.BILLING_CLIENT_ID?.trim() || 'trevra-billing',
    clientSecret,
    audience: env.BILLING_AUDIENCE?.trim().replace(/\/$/, '') || 'https://billing.olaryn.com'
  };
}

export function billingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return configuredBilling(env) !== null;
}

export class TrevraBillingClient implements BillingApi {
  private tokenEndpoint: string | null = null;
  private token: CachedToken | null = null;

  constructor(
    private readonly config: BillingClientConfig,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  private async discoverTokenEndpoint(): Promise<string> {
    if (this.tokenEndpoint) return this.tokenEndpoint;
    const response = await this.fetchImpl(
      `${this.config.authwardIssuer}/.well-known/openid-configuration`,
      {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(5_000)
      }
    );
    if (!response.ok) {
      throw new BillingServiceError(
        `Authward discovery failed with ${response.status}`,
        response.status
      );
    }
    const payload = (await response.json()) as { token_endpoint?: string };
    if (!payload.token_endpoint)
      throw new BillingServiceError('Authward discovery has no token_endpoint');
    this.tokenEndpoint = payload.token_endpoint;
    return payload.token_endpoint;
  }

  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAt - 60_000 > now) return this.token.value;

    const tokenEndpoint = await this.discoverTokenEndpoint();
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'billing:access',
      resource: this.config.audience
    });
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString(
      'base64'
    );
    const response = await this.fetchImpl(tokenEndpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded'
      },
      body,
      signal: AbortSignal.timeout(5_000)
    });
    const payload = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!response.ok || !payload.access_token) {
      throw new BillingServiceError(
        payload.error_description ||
          payload.error ||
          `Authward token request failed with ${response.status}`,
        response.status
      );
    }
    const expiresIn = Math.max(60, Number(payload.expires_in ?? 900));
    this.token = { value: payload.access_token, expiresAt: now + expiresIn * 1000 };
    return payload.access_token;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.accessToken();
    const response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers ?? {})
      },
      signal: init.signal ?? AbortSignal.timeout(10_000)
    });
    if (!response.ok) {
      let detail = `Billing request failed with ${response.status}`;
      try {
        const payload = (await response.json()) as { detail?: string; error?: string };
        detail = payload.detail || payload.error || detail;
      } catch {
        // Keep the status-only message. Never surface provider response bodies.
      }
      throw new BillingServiceError(detail, response.status);
    }
    return (await response.json()) as T;
  }

  private customerPath(workspaceId: string): string {
    return `/v1/trevra/customers/${encodeURIComponent(workspaceId)}`;
  }

  async plans(): Promise<BillingPlan[]> {
    const payload = await this.request<{ plans: BillingPlan[] }>('/v1/trevra/catalog/plans');
    return payload.plans;
  }

  async startPlan(input: {
    workspaceId: string;
    planCode: string;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
  }): Promise<BillingCheckout> {
    return this.request<BillingCheckout>(`${this.customerPath(input.workspaceId)}/subscription`, {
      method: 'POST',
      headers: { 'Idempotency-Key': input.idempotencyKey },
      body: JSON.stringify({
        plan_code: input.planCode,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl
      })
    });
  }
  async ensureWorkspaceCustomer(input: {
    workspaceId: string;
    name: string;
    currency?: string;
  }): Promise<BillingCustomer> {
    return this.request<BillingCustomer>(this.customerPath(input.workspaceId), {
      method: 'PUT',
      body: JSON.stringify({
        name: input.name,
        billing_email: null,
        currency: input.currency ?? 'USD',
        resources: [['workspace', input.workspaceId]],
        metadata: { workspace_id: input.workspaceId }
      })
    });
  }

  async workspaceSnapshot(input: {
    workspaceId: string;
    name: string;
    currency?: string;
  }): Promise<TrevraBillingSnapshot> {
    const customer = await this.ensureWorkspaceCustomer(input);
    const base = this.customerPath(input.workspaceId);
    const [subscription, credits, entitlements] = await Promise.all([
      this.request<BillingSubscription>(`${base}/subscription`),
      this.request<BillingCredits>(`${base}/credits`),
      this.request<BillingEntitlements>(`${base}/entitlements`)
    ]);
    return { enabled: true, customer, subscription, credits, entitlements };
  }

  async previewPlanChange(input: {
    workspaceId: string;
    planCode: string;
  }): Promise<BillingPlanPreview> {
    return this.request<BillingPlanPreview>(
      `${this.customerPath(input.workspaceId)}/subscription/preview`,
      { method: 'POST', body: JSON.stringify({ plan_code: input.planCode }) }
    );
  }

  async changePlan(input: {
    workspaceId: string;
    planCode: string;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
  }): Promise<BillingLifecycleResult> {
    return this.request<BillingLifecycleResult>(
      `${this.customerPath(input.workspaceId)}/subscription/change`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': input.idempotencyKey },
        body: JSON.stringify({
          plan_code: input.planCode,
          success_url: input.successUrl,
          cancel_url: input.cancelUrl
        })
      }
    );
  }

  async cancelSubscription(input: {
    workspaceId: string;
    idempotencyKey: string;
  }): Promise<BillingLifecycleResult> {
    return this.request<BillingLifecycleResult>(
      `${this.customerPath(input.workspaceId)}/subscription/cancel`,
      { method: 'POST', headers: { 'Idempotency-Key': input.idempotencyKey } }
    );
  }

  async resumeSubscription(input: {
    workspaceId: string;
    idempotencyKey: string;
  }): Promise<BillingLifecycleResult> {
    return this.request<BillingLifecycleResult>(
      `${this.customerPath(input.workspaceId)}/subscription/resume`,
      { method: 'POST', headers: { 'Idempotency-Key': input.idempotencyKey } }
    );
  }

  async reserveCredits(input: {
    workspaceId: string;
    amount: string;
    operation: string;
    idempotencyKey: string;
    ttlSeconds: number;
    resourceType: string;
    resourceId: string;
  }): Promise<BillingReservation> {
    return this.request<BillingReservation>(
      `${this.customerPath(input.workspaceId)}/reservations`,
      {
        method: 'POST',
        body: JSON.stringify({
          amount: input.amount,
          operation: input.operation,
          idempotency_key: input.idempotencyKey,
          ttl_seconds: input.ttlSeconds,
          resource_type: input.resourceType,
          resource_id: input.resourceId
        })
      }
    );
  }

  async settleReservation(input: {
    workspaceId: string;
    reservationId: string;
  }): Promise<BillingReservation> {
    return this.request<BillingReservation>(
      `${this.customerPath(input.workspaceId)}/reservations/${encodeURIComponent(input.reservationId)}/settle`,
      { method: 'POST', body: JSON.stringify({}) }
    );
  }
}

let singleton: BillingApi | null | undefined;

export function getBillingClient(env: NodeJS.ProcessEnv = process.env): BillingApi | null {
  if (env !== process.env) {
    const config = configuredBilling(env);
    return config ? new TrevraBillingClient(config) : null;
  }
  if (singleton !== undefined) return singleton;
  const config = configuredBilling(env);
  singleton = config ? new TrevraBillingClient(config) : null;
  return singleton;
}

export function resetBillingClientForTests(): void {
  singleton = undefined;
}

/** Tests only: substitute a fake Billing (or `null` for an unconfigured deployment). */
export function setBillingClientForTests(client: BillingApi | null): void {
  singleton = client;
}
