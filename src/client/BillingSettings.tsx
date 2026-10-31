import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BadgeDollarSign, CalendarClock, Gauge, ReceiptText } from 'lucide-react';
import {
  cancelBillingPlan,
  changeBillingPlan,
  getBillingPlans,
  getBillingSnapshot,
  previewBillingPlan,
  resumeBillingPlan,
  startBillingCheckout,
  type BillingPlan,
  type BillingPlanPreview,
  type BillingSnapshot,
  type BillingUsageLine
} from './api';
import { ConfirmDrawer } from './ui/dialog';
import { EmptyState, PageGrid, Panel } from './ui/layout';
import { Button } from './ui/primitives';

function credits(value: string | number): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return String(value);
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(parsed);
}

function statusLabel(value: string): string {
  return value
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
}

function money(plan: BillingPlan): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: plan.currency,
    maximumFractionDigits: 0
  }).format(Number(plan.amount));
}

function cents(amount: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount / 100);
}

function day(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(date);
}

function tierRank(tier: string): number {
  return ['starter', 'growth', 'scale'].indexOf(tier);
}

function limitLabel(line: BillingUsageLine): string {
  if (line.limit === null) return 'Unlimited';
  if (line.limit === 0) return 'Not included';
  return String(line.limit);
}

function OverLimitList({ lines }: { lines: BillingUsageLine[] }) {
  return (
    <ul className="billing-over-list">
      {lines.map((line) => (
        <li key={line.key}>
          {line.label}: {line.used} in use, the new plan allows {limitLabel(line).toLowerCase()}.
        </li>
      ))}
    </ul>
  );
}

type PendingAction =
  | {
      kind: 'change';
      plan: BillingPlan;
      direction: 'upgrade' | 'downgrade' | 'switch';
      preview: BillingPlanPreview;
    }
  | { kind: 'cancel' };

const PANEL_DESCRIPTION =
  'Commercial state for this workspace is owned by the shared Olaryn Billing service.';

export function BillingSettings() {
  const [snapshot, setSnapshot] = useState<BillingSnapshot | null>(null);
  const [plans, setPlans] = useState<BillingPlan[]>([]);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [pending, setPending] = useState<PendingAction | null>(null);
  // One nonce per user intent (action + target). A retry or double click
  // reuses it, so the server derives the same Billing idempotency key and the
  // action happens once; a completed intent gets a fresh nonce next time.
  const nonces = useRef(new Map<string, string>());
  const nonceFor = (intent: string) => {
    let nonce = nonces.current.get(intent);
    if (!nonce) {
      nonce = crypto.randomUUID();
      nonces.current.set(intent, nonce);
    }
    return nonce;
  };

  const load = useCallback(async () => {
    const [nextSnapshot, nextPlans] = await Promise.all([getBillingSnapshot(), getBillingPlans()]);
    setSnapshot(nextSnapshot);
    setPlans(nextPlans.plans);
    setLoadError('');
  }, []);

  useEffect(() => {
    let live = true;
    load().catch((caught) => {
      if (live)
        setLoadError(caught instanceof Error ? caught.message : 'Unable to read billing state.');
    });
    return () => {
      live = false;
    };
  }, [load]);

  const planRows = useMemo(() => {
    const monthly = plans
      .filter((plan) => plan.interval === 'monthly')
      .sort((a, b) => tierRank(a.tier) - tierRank(b.tier));
    return monthly.map((plan) => ({
      monthly: plan,
      yearly: plans.find(
        (candidate) => candidate.tier === plan.tier && candidate.interval === 'yearly'
      )
    }));
  }, [plans]);

  if (loadError || !snapshot || !snapshot.enabled) {
    return (
      <PageGrid columns={1}>
        <Panel title="Billing" description={PANEL_DESCRIPTION} icon={<BadgeDollarSign size={18} />}>
          {loadError ? (
            <EmptyState title="Billing unavailable" description={loadError} />
          ) : !snapshot ? (
            <p className="empty-copy">Reading workspace billing…</p>
          ) : (
            <EmptyState
              title="Billing is not configured"
              description="This deployment is running without the shared Billing service. Plan limits are not enforced and billing remains optional until the hosted commercial stack is enabled."
            />
          )}
        </Panel>
      </PageGrid>
    );
  }

  const canManage = snapshot.canManage;
  const currentPlanCode = snapshot.subscription.plan_code ?? snapshot.customer.plan_code;
  const currentPlan = plans.find((plan) => plan.plan_code === currentPlanCode) ?? null;
  const subscriptionStatus = snapshot.subscription.status || 'none';
  const hasSubscription = !['none', 'canceled', 'incomplete_expired'].includes(subscriptionStatus);
  const renewal = snapshot.renewal;
  const overLines = snapshot.usage.filter((line) => line.over);
  const enforced = snapshot.enforcement === 'enforce';
  const query = new URLSearchParams(window.location.search);
  const checkoutState = query.get('checkout');
  const requestedPlan = query.get('plan');

  const run = async (key: string, work: () => Promise<void>) => {
    setBusy(key);
    setActionError('');
    setNotice('');
    try {
      await work();
    } catch (caught) {
      setActionError(
        caught instanceof Error ? caught.message : 'Billing did not accept that change.'
      );
    } finally {
      setBusy('');
    }
  };

  const checkout = (plan: BillingPlan) =>
    run(`checkout:${plan.plan_code}`, async () => {
      const result = await startBillingCheckout(
        plan.plan_code,
        nonceFor(`checkout:${plan.plan_code}`)
      );
      if (result.url) {
        window.location.assign(result.url);
        return;
      }
      setActionError(result.message || 'Billing did not return a checkout URL.');
    });

  const direction = (plan: BillingPlan): 'upgrade' | 'downgrade' | 'switch' => {
    if (!currentPlan) return 'upgrade';
    const delta = tierRank(plan.tier) - tierRank(currentPlan.tier);
    return delta > 0 ? 'upgrade' : delta < 0 ? 'downgrade' : 'switch';
  };

  const startChange = (plan: BillingPlan) =>
    run(`preview:${plan.plan_code}`, async () => {
      const preview = await previewBillingPlan(plan.plan_code);
      setPending({ kind: 'change', plan, direction: direction(plan), preview });
    });

  const confirmChange = (plan: BillingPlan) =>
    run(`change:${plan.plan_code}`, async () => {
      const intent = `change:${plan.plan_code}`;
      const response = await changeBillingPlan(plan.plan_code, nonceFor(intent));
      nonces.current.delete(intent);
      if (response.result.url) {
        window.location.assign(response.result.url);
        return;
      }
      setPending(null);
      setNotice(
        response.result.status === 'scheduled'
          ? `${plan.name} starts at the end of the current period. Nothing is deleted.`
          : `Plan changed to ${plan.name}.`
      );
      await load();
    });

  const confirmCancel = () =>
    run('cancel', async () => {
      await cancelBillingPlan(nonceFor('cancel'));
      nonces.current.delete('cancel');
      setPending(null);
      setNotice('The plan is set to end at the close of the current period. Your data is kept.');
      await load();
    });

  const resume = () =>
    run('resume', async () => {
      await resumeBillingPlan(nonceFor('resume'));
      nonces.current.delete('resume');
      setNotice('The plan will renew as usual.');
      await load();
    });

  const planButtonLabel = (plan: BillingPlan, isCurrent: boolean) => {
    if (isCurrent) return 'Current plan';
    if (busy === `checkout:${plan.plan_code}`) return 'Opening checkout…';
    if (busy === `preview:${plan.plan_code}`) return 'Checking the change…';
    if (!hasSubscription) return plan.interval === 'yearly' ? 'Choose yearly' : 'Choose monthly';
    const move = direction(plan);
    const interval = plan.interval === 'yearly' ? 'yearly' : 'monthly';
    if (move === 'switch') return `Switch to ${interval}`;
    return `${move === 'upgrade' ? 'Upgrade' : 'Downgrade'} (${interval})`;
  };

  const choose = (plan: BillingPlan) => (hasSubscription ? startChange(plan) : checkout(plan));

  return (
    <PageGrid columns={1}>
      <Panel
        title="Billing"
        description="Plan, trial and renewal for this workspace, read from the shared Billing service."
        icon={<BadgeDollarSign size={18} />}
        actions={<span className="status-pill">{statusLabel(subscriptionStatus)}</span>}
      >
        {checkoutState === 'success' && (
          <p className="panel-note">
            Checkout completed. Stripe confirmation can take a moment to update the subscription and
            credit balance.
          </p>
        )}
        {checkoutState === 'cancelled' && (
          <p className="panel-note">Checkout was cancelled. Nothing changed.</p>
        )}
        {snapshot.state.stale && snapshot.state.withinGrace && (
          <p className="billing-notice" role="status">
            Billing could not be reached. Showing the plan as of {day(snapshot.state.fetchedAt)};
            limits keep applying from it until {day(snapshot.state.graceEndsAt)}.
          </p>
        )}
        {!enforced && (
          <p className="panel-note" role="status">
            {snapshot.enforcement === 'off'
              ? 'Plan limits are not enforced on this deployment: nothing is blocked and no usage is charged.'
              : 'Plan limits are observed, not enforced yet: nothing is blocked and no usage is charged. Expansions past the plan are recorded for review.'}
          </p>
        )}
        {snapshot.expansionBlock &&
          (enforced ? (
            <p className="billing-notice billing-notice-blocked" role="status">
              {snapshot.expansionBlock.reason}
            </p>
          ) : (
            <p className="billing-notice" role="status">
              Would block once limits are enforced: {snapshot.expansionBlock.reason}
            </p>
          ))}
        {snapshot.trial?.active && (
          <p className="billing-notice" role="status">
            Trial active until {day(snapshot.trial.endsAt)}. Choose a plan before then to keep
            adding campaigns, accounts and teammates; your data is kept either way.
          </p>
        )}
        {renewal.cancelAtPeriodEnd && renewal.endsOn && (
          <p className="billing-notice" role="status">
            The plan ends on {day(renewal.endsOn)} and will not renew. Your data is kept.
          </p>
        )}
        {renewal.scheduledPlanCode && renewal.renewsOn && (
          <p className="panel-note">
            Changes to {statusLabel(renewal.scheduledPlanCode)} on {day(renewal.renewsOn)}.
          </p>
        )}
        {renewal.noticeDue && renewal.renewsOn && (
          <p className="billing-notice" role="status">
            Your annual plan renews on {day(renewal.renewsOn)}.
          </p>
        )}

        <div className="metrics-grid metrics-grid-four">
          <div className="metric-card">
            <span className="metric-icon">
              <ReceiptText />
            </span>
            <div>
              <p>Plan</p>
              <strong>
                {currentPlan?.name ?? (currentPlanCode ? statusLabel(currentPlanCode) : 'No plan')}
              </strong>
              <span>
                {currentPlan
                  ? currentPlan.interval === 'yearly'
                    ? 'Billed yearly'
                    : 'Billed monthly'
                  : snapshot.customer.currency}
              </span>
            </div>
          </div>
          <div className="metric-card">
            <span className="metric-icon">
              <Gauge />
            </span>
            <div>
              <p>Available credits</p>
              <strong>{credits(snapshot.credits.available)}</strong>
              <span>{credits(snapshot.credits.usage)} used this period</span>
            </div>
          </div>
          <div className="metric-card">
            <span className="metric-icon">
              <CalendarClock />
            </span>
            <div>
              <p>{snapshot.trial ? 'Trial ends' : renewal.endsOn ? 'Plan ends' : 'Renews'}</p>
              <strong>
                {day(snapshot.trial ? snapshot.trial.endsAt : (renewal.endsOn ?? renewal.renewsOn))}
              </strong>
              <span>
                {snapshot.trial?.expired
                  ? 'Trial ended'
                  : renewal.annual
                    ? 'Annual plan'
                    : 'Current period'}
              </span>
            </div>
          </div>
          <div className="metric-card">
            <span className="metric-icon">
              <BadgeDollarSign />
            </span>
            <div>
              <p>Payment profile</p>
              <strong>
                {snapshot.customer.has_payment_profile ? 'On file' : 'Not needed yet'}
              </strong>
              <span>Created at paid checkout</span>
            </div>
          </div>
        </div>
      </Panel>

      <Panel
        title="Usage against plan limits"
        description="Limits apply to adding new campaigns, LinkedIn accounts and teammates. Running work and existing data are never stopped or deleted by a limit."
        icon={<Gauge size={18} />}
      >
        <div className="li-table-scroll">
          <table className="li-table">
            <thead>
              <tr>
                <th scope="col">Resource</th>
                <th scope="col">In use</th>
                <th scope="col">Plan limit</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.usage.map((line) => (
                <tr key={line.key}>
                  <td>{line.label}</td>
                  <td>{line.used}</td>
                  <td>{limitLabel(line)}</td>
                  <td>
                    <span className={`status-pill ${line.over ? 'warn' : 'ok'}`}>
                      {line.over ? 'Over limit' : 'Within plan'}
                    </span>
                  </td>
                </tr>
              ))}
              <tr>
                <td>Credits</td>
                <td>{credits(snapshot.credits.usage)}</td>
                <td>{credits(snapshot.credits.balance)}</td>
                <td>
                  <span
                    className={`status-pill ${Number(snapshot.credits.available) < 1 ? 'warn' : 'ok'}`}
                  >
                    {Number(snapshot.credits.available) < 1 ? 'Exhausted' : 'Available'}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        {overLines.length > 0 && (
          <p className={`billing-notice${enforced ? ' billing-notice-blocked' : ''}`} role="status">
            Over the current plan: {overLines.map((line) => line.label.toLowerCase()).join(', ')}.
            Nothing has been deleted.{' '}
            {enforced
              ? 'Adding more is blocked until usage is back within the plan or the plan is upgraded.'
              : 'Nothing is blocked while limits are not enforced; once they are, adding more needs usage back within the plan or an upgrade.'}
          </p>
        )}
      </Panel>

      <Panel
        title="Plans"
        description="Upgrades apply immediately with a prorated charge. Downgrades and cancellation take effect at the end of the current period."
        icon={<ReceiptText size={18} />}
        actions={<span className="status-pill">Preview pricing</span>}
      >
        {notice && (
          <p className="panel-note" role="status">
            {notice}
          </p>
        )}
        {actionError && !pending && <div className="error-banner">{actionError}</div>}
        {!canManage && (
          <p className="panel-note">Only the workspace owner can change or cancel the plan.</p>
        )}
        {planRows.length === 0 ? (
          <EmptyState
            title="No plans published"
            description="The shared Billing service did not return a Trevra catalog."
          />
        ) : (
          <div className="billing-plan-grid">
            {planRows.map(({ monthly, yearly }) => {
              const isRequested =
                requestedPlan === monthly.plan_code || requestedPlan === yearly?.plan_code;
              return (
                <article
                  className={`billing-plan-card${isRequested ? ' billing-plan-card-selected' : ''}`}
                  key={monthly.tier}
                >
                  <div>
                    <p className="eyebrow">{monthly.name}</p>
                    <strong className="billing-plan-price">
                      {money(monthly)}
                      <span>/month</span>
                    </strong>
                    {isRequested && <p className="billing-plan-requested">Selected from pricing</p>}
                    {yearly && (
                      <p className="billing-plan-annual">
                        {money(yearly)}/year · save{' '}
                        {Math.round(
                          100 - (Number(yearly.amount) / (Number(monthly.amount) * 12)) * 100
                        )}
                        %
                      </p>
                    )}
                  </div>
                  <p>{credits(monthly.monthly_credits)} credits per month</p>
                  <div className="billing-plan-actions">
                    {[monthly, yearly]
                      .filter((plan): plan is BillingPlan => Boolean(plan))
                      .map((plan) => {
                        const isCurrent = currentPlanCode === plan.plan_code;
                        return (
                          <Button
                            key={plan.plan_code}
                            variant={
                              !isCurrent &&
                              plan.interval === 'monthly' &&
                              plan.tier === 'growth' &&
                              !hasSubscription
                                ? 'primary'
                                : plan.interval === 'monthly'
                                  ? 'secondary'
                                  : 'ghost'
                            }
                            disabled={
                              !canManage || isCurrent || busy !== '' || plan.contact_required
                            }
                            onClick={() => void choose(plan)}
                          >
                            {plan.contact_required
                              ? 'Contact sales'
                              : planButtonLabel(plan, isCurrent)}
                          </Button>
                        );
                      })}
                  </div>
                </article>
              );
            })}
          </div>
        )}
        {canManage && hasSubscription && (
          <div className="panel-footer billing-lifecycle-actions">
            {renewal.cancelAtPeriodEnd ? (
              <Button variant="secondary" disabled={busy !== ''} onClick={() => void resume()}>
                {busy === 'resume' ? 'Resuming…' : 'Keep the plan (resume renewal)'}
              </Button>
            ) : (
              <Button
                variant="danger"
                disabled={busy !== ''}
                onClick={() => setPending({ kind: 'cancel' })}
              >
                Cancel plan
              </Button>
            )}
          </div>
        )}
        <p className="panel-note">
          These prices are deliberately provisional. The checkout path is real; the commercial
          numbers are placeholders until Trevra pricing is finalized.
        </p>
      </Panel>

      {pending?.kind === 'change' && (
        <ConfirmDrawer
          title={
            pending.direction === 'downgrade'
              ? `Downgrade to ${pending.plan.name}?`
              : pending.direction === 'upgrade'
                ? `Upgrade to ${pending.plan.name}?`
                : `Switch to ${pending.plan.name} (${pending.plan.interval})?`
          }
          tone={pending.direction === 'downgrade' ? 'caution' : 'default'}
          confirmLabel={
            pending.direction === 'downgrade'
              ? `Downgrade at period end`
              : pending.preview.preview.apply_immediately
                ? `Change plan now`
                : `Change plan at period end`
          }
          busy={busy === `change:${pending.plan.plan_code}`}
          error={actionError || null}
          onCancel={() => {
            setPending(null);
            setActionError('');
          }}
          onConfirm={() => void confirmChange(pending.plan)}
          body={
            <div className="billing-confirm-body">
              <p>
                {pending.preview.preview.apply_immediately
                  ? `Takes effect now. Due today: ${cents(pending.preview.preview.amount_due, pending.preview.preview.currency)}.`
                  : `Takes effect on ${day(pending.preview.preview.current_period_end ?? renewal.renewsOn)}. Nothing is charged today.`}{' '}
                The new plan includes {credits(pending.preview.preview.credits_new)} credits per
                period.
              </p>
              {pending.preview.overLimit && pending.preview.overLimit.length > 0 ? (
                <>
                  <p>
                    This workspace already uses more than {pending.plan.name} allows. Nothing will
                    be deleted and running work continues, but adding more{' '}
                    {enforced ? 'is blocked' : 'will be blocked once limits are enforced'} until
                    usage is back within the plan:
                  </p>
                  <OverLimitList lines={pending.preview.overLimit} />
                </>
              ) : null}
            </div>
          }
        />
      )}

      {pending?.kind === 'cancel' && (
        <ConfirmDrawer
          title="Cancel the plan at the end of this period?"
          tone="danger"
          confirmLabel="Cancel at period end"
          busy={busy === 'cancel'}
          error={actionError || null}
          onCancel={() => {
            setPending(null);
            setActionError('');
          }}
          onConfirm={() => void confirmCancel()}
          body={
            <div className="billing-confirm-body">
              <p>
                The plan stays active until {day(renewal.renewsOn)} and does not renew after that.
                Your campaigns, leads, conversations and settings are kept.
              </p>
              <p>
                After it ends, new campaigns, LinkedIn accounts and teammates cannot be added until
                a plan is chosen again. You can resume the plan any time before it ends.
              </p>
            </div>
          }
        />
      )}
    </PageGrid>
  );
}
