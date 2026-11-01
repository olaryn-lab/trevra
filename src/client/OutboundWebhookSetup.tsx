import { useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Copy,
  KeyRound,
  LoaderCircle,
  PauseCircle,
  PlayCircle,
  Plus,
  RotateCcw,
  Send
} from 'lucide-react';
import {
  OUTBOUND_WEBHOOK_EVENTS,
  createOutboundWebhook,
  getOutboundWebhookDeliveries,
  getOutboundWebhookHealth,
  getOutboundWebhooks,
  replayOutboundWebhookDeliveries,
  replayOutboundWebhookDelivery,
  rotateOutboundWebhookSecret,
  updateOutboundWebhook,
  type OutboundWebhookDelivery,
  type OutboundWebhookEventType,
  type OutboundWebhookHealth,
  type OutboundWebhookSubscription
} from './api';
import { Button, Field, Input, Select, SwitchField } from './ui/primitives';
import { ConfirmDrawer } from './ui/dialog';
import { errorMessage } from './LinkedInSafety';
import { relativeTime } from './LinkedInScreen';
import { copyText } from './provider-webhook-view';
import {
  ROTATION_OVERLAP_HOURS,
  endpointHost,
  overlapLabel,
  reasonLabel,
  subscriptionStatus
} from './outbound-webhook-view';

/** Mirrors the server's bulk replay cap (`OUTBOUND_WEBHOOK_REPLAY_CAP`). */
const OUTBOUND_WEBHOOK_REPLAY_BATCH = 500;

export type OutboundWebhookDetailData = {
  health: OutboundWebhookHealth;
  dead: OutboundWebhookDelivery[];
};

/**
 * Owner panel for signed outbound lifecycle webhooks: create, pause/resume,
 * rotate the signing secret with an overlap, inspect delivery health and
 * replay dead-lettered deliveries. Secrets appear exactly once, in the reply
 * that created them.
 */
export function OutboundWebhookSetup({ setToast }: { setToast: (message: string) => void }) {
  const [subscriptions, setSubscriptions] = useState<OutboundWebhookSubscription[]>([]);
  const [load, setLoad] = useState<'pending' | 'ok' | 'error'>('pending');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState('');
  const [revealed, setRevealed] = useState<{ id: string; secret: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, OutboundWebhookDetailData>>({});
  const [rotating, setRotating] = useState<OutboundWebhookSubscription | null>(null);
  const [overlapHours, setOverlapHours] = useState('24');
  const [creating, setCreating] = useState(false);
  const [draftUrl, setDraftUrl] = useState('');
  const [draftEvents, setDraftEvents] = useState<OutboundWebhookEventType[]>([
    'linkedin_campaign.started'
  ]);

  const reload = () => {
    setLoad('pending');
    setProblem('');
    void getOutboundWebhooks()
      .then((result) => {
        setSubscriptions(result);
        setLoad('ok');
      })
      .catch((error) => {
        setProblem(errorMessage(error, 'Unable to load outbound webhooks.'));
        setLoad('error');
      });
  };
  useEffect(reload, []);

  const replace = (next: OutboundWebhookSubscription) =>
    setSubscriptions((current) => current.map((item) => (item.id === next.id ? next : item)));

  const loadDetail = async (id: string) => {
    const [health, deliveries] = await Promise.all([
      getOutboundWebhookHealth(id),
      getOutboundWebhookDeliveries(id)
    ]);
    setDetails((current) => ({
      ...current,
      [id]: { health, dead: deliveries.filter((item) => item.status === 'dead') }
    }));
  };

  const run = async (key: string, work: () => Promise<void>, failure: string) => {
    setBusy(key);
    setProblem('');
    try {
      await work();
    } catch (error) {
      setProblem(errorMessage(error, failure));
    } finally {
      setBusy('');
    }
  };

  const toggleDetail = (id: string) => {
    if (expanded === id) return setExpanded(null);
    setExpanded(id);
    void run(`detail:${id}`, () => loadDetail(id), 'Unable to load delivery health.');
  };

  const create = () =>
    run(
      'create',
      async () => {
        const result = await createOutboundWebhook({
          url: draftUrl.trim(),
          eventTypes: draftEvents
        });
        setSubscriptions((current) => [...current, result.subscription]);
        setRevealed({ id: result.subscription.id, secret: result.signingSecret });
        setCreating(false);
        setDraftUrl('');
        setToast('Endpoint added. Copy the signing secret now.');
      },
      'Unable to add the endpoint.'
    );

  const setActive = (subscription: OutboundWebhookSubscription, active: boolean) =>
    run(
      subscription.id,
      async () => {
        replace(await updateOutboundWebhook(subscription.id, { active }));
        setToast(
          active ? 'Endpoint resumed.' : 'Endpoint paused. Queued deliveries moved to dead letters.'
        );
        if (expanded === subscription.id) await loadDetail(subscription.id);
      },
      active ? 'Unable to resume the endpoint.' : 'Unable to pause the endpoint.'
    );

  const rotate = (subscription: OutboundWebhookSubscription) =>
    run(
      `rotate:${subscription.id}`,
      async () => {
        const result = await rotateOutboundWebhookSecret(subscription.id, Number(overlapHours));
        replace(result.subscription);
        setRevealed({ id: subscription.id, secret: result.signingSecret });
        setRotating(null);
        setToast('Signing secret rotated. Copy the new secret now.');
      },
      'Unable to rotate the signing secret.'
    );

  const replay = (subscription: OutboundWebhookSubscription, deliveryId?: string) =>
    run(
      `replay:${deliveryId ?? subscription.id}`,
      async () => {
        // Bulk replay asks for the oldest batch at the server cap, so a backlog
        // past it is replayed in repeated clicks instead of a refused request.
        const result = deliveryId
          ? await replayOutboundWebhookDelivery(subscription.id, deliveryId)
          : await replayOutboundWebhookDeliveries(subscription.id, OUTBOUND_WEBHOOK_REPLAY_BATCH);
        setToast(
          result.replayed === 1
            ? 'One delivery queued for replay.'
            : result.replayed === OUTBOUND_WEBHOOK_REPLAY_BATCH
              ? `${result.replayed} deliveries queued for replay. Replay again for any remaining.`
              : `${result.replayed} deliveries queued for replay.`
        );
        await loadDetail(subscription.id);
      },
      'Unable to replay deliveries.'
    );

  const copySecret = (secret: string) =>
    void copyText(secret).then((copied) =>
      setToast(copied ? 'Secret copied.' : 'Copy failed — select the secret and copy it manually.')
    );

  return (
    <section className="page-panel" id="outbound-webhooks">
      <div className="section-heading">
        <div>
          <h3>Outbound webhooks</h3>
          <p>
            Send signed campaign and playbook lifecycle events to your own HTTPS endpoint. Payloads
            carry ids and timestamps only, never message bodies or lead data.
          </p>
        </div>
        <Send size={20} aria-hidden />
      </div>
      {problem && (
        <div className="error-banner" role="alert">
          {problem}
        </div>
      )}
      {load === 'error' && (
        <div className="capture-row-actions">
          <Button onClick={reload}>Try again</Button>
        </div>
      )}

      {subscriptions.map((subscription) => {
        const status = subscriptionStatus(subscription);
        const detail = details[subscription.id];
        const open = expanded === subscription.id;
        const rowBusy = busy === subscription.id;
        return (
          <article className="capture-webhook-endpoint" key={subscription.id}>
            <header>
              <strong>{endpointHost(subscription.url)}</strong>
              <span className={`status-pill ${status.tone}`}>{status.label}</span>
            </header>
            <div className="capture-secret">
              <strong>Endpoint URL</strong>
              <code>{subscription.url}</code>
            </div>
            <p className="li-hint">Events: {subscription.eventTypes.join(', ')}</p>
            {subscription.disabledReason === 'consecutive_failures' && (
              <div className="error-banner" role="status">
                Paused automatically after {subscription.consecutiveFailures} failed attempts in a
                row ({reasonLabel(subscription.lastFailureCode)}). Fix the endpoint, resume it, then
                replay the dead deliveries.
              </div>
            )}
            {subscription.previousSecretExpiresAt && (
              <p className="li-hint">
                The previous signing secret also signs deliveries until{' '}
                {new Date(subscription.previousSecretExpiresAt).toLocaleString()}.
              </p>
            )}
            {revealed?.id === subscription.id ? (
              <div className="capture-secret">
                <strong>Signing secret — shown only now</strong>
                <code>{revealed.secret}</code>
                <div className="capture-actions">
                  <Button onClick={() => copySecret(revealed.secret)}>
                    <Copy size={14} aria-hidden /> Copy secret
                  </Button>
                  <Button variant="ghost" onClick={() => setRevealed(null)}>
                    I saved it
                  </Button>
                </div>
              </div>
            ) : null}
            <div className="capture-actions">
              <Button
                aria-expanded={open}
                aria-controls={`outbound-webhook-detail-${subscription.id}`}
                onClick={() => toggleDetail(subscription.id)}
              >
                {open ? <ChevronUp size={15} aria-hidden /> : <ChevronDown size={15} aria-hidden />}
                Delivery health
              </Button>
              <Button
                disabled={busy === `rotate:${subscription.id}`}
                onClick={() => {
                  setOverlapHours('24');
                  setRotating(subscription);
                }}
              >
                <KeyRound size={15} aria-hidden /> Rotate secret
              </Button>
              <Button
                disabled={rowBusy}
                onClick={() => void setActive(subscription, !subscription.active)}
              >
                {subscription.active ? (
                  <PauseCircle size={15} aria-hidden />
                ) : (
                  <PlayCircle size={15} aria-hidden />
                )}
                {subscription.active ? 'Pause' : 'Resume'}
              </Button>
            </div>
            {open && (
              <div
                className="outbound-webhook-detail"
                id={`outbound-webhook-detail-${subscription.id}`}
              >
                {!detail ? (
                  <p className="li-hint">
                    <LoaderCircle className="spin" size={14} aria-hidden /> Loading delivery health…
                  </p>
                ) : (
                  <OutboundWebhookDetail
                    subscription={subscription}
                    detail={detail}
                    busy={busy}
                    onReplay={(deliveryId) => void replay(subscription, deliveryId)}
                  />
                )}
              </div>
            )}
          </article>
        );
      })}

      {load === 'ok' && subscriptions.length === 0 && !creating && (
        <p className="li-hint">No endpoints yet.</p>
      )}

      {load === 'ok' && !creating && (
        <div className="capture-row-actions">
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus size={15} aria-hidden /> Add endpoint
          </Button>
        </div>
      )}

      {creating && (
        <div className="capture-webhook-connect">
          <Field
            label="Endpoint URL"
            hint="HTTPS on a host your Trevra operator has approved. No IP address, port, credentials or query string."
          >
            <Input
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={draftUrl}
              placeholder="https://hooks.example.com/trevra"
              onChange={(event) => setDraftUrl(event.target.value)}
            />
          </Field>
          <div className="outbound-webhook-events" role="group" aria-label="Events to send">
            {OUTBOUND_WEBHOOK_EVENTS.map((eventType) => (
              <SwitchField
                key={eventType}
                label={eventType}
                checked={draftEvents.includes(eventType)}
                onChange={(event) =>
                  setDraftEvents((current) =>
                    event.target.checked
                      ? [...current, eventType]
                      : current.filter((item) => item !== eventType)
                  )
                }
              />
            ))}
          </div>
          <div className="capture-row-actions">
            <Button
              variant="primary"
              disabled={!draftUrl.trim() || draftEvents.length === 0 || busy === 'create'}
              onClick={() => void create()}
            >
              {busy === 'create' && <LoaderCircle className="spin" size={15} aria-hidden />}
              Add endpoint
            </Button>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {rotating && (
        <ConfirmDrawer
          title="Rotate the signing secret?"
          body={
            <>
              <p>
                Trevra issues a new secret and shows it once. During the overlap each delivery
                carries two <code>v1</code> signatures, new first, so your endpoint keeps verifying
                while you deploy the new secret.
              </p>
              <Field label="Keep the old secret signing for">
                <Select
                  value={overlapHours}
                  onChange={(event) => setOverlapHours(event.target.value)}
                >
                  {ROTATION_OVERLAP_HOURS.map((hours) => (
                    <option key={hours} value={String(hours)}>
                      {overlapLabel(hours)}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          }
          confirmLabel="Rotate secret"
          busy={busy === `rotate:${rotating.id}`}
          onConfirm={() => void rotate(rotating)}
          onCancel={() => setRotating(null)}
        />
      )}
    </section>
  );
}

export function OutboundWebhookDetail({
  subscription,
  detail,
  busy,
  onReplay
}: {
  subscription: OutboundWebhookSubscription;
  detail: OutboundWebhookDetailData;
  busy: string;
  onReplay: (deliveryId?: string) => void;
}) {
  const { stats, attempts } = detail.health;
  const windows = [
    ['Last 24 hours', stats.last24h],
    ['Last 7 days', stats.last7d]
  ] as const;
  return (
    <>
      {windows.map(([label, counts]) => (
        <div key={label}>
          <p className="li-hint">{label}</p>
          <div className="capture-metrics">
            <span>
              <strong>{counts.delivered}</strong>
              <small>Delivered</small>
            </span>
            <span>
              <strong>{counts.failed}</strong>
              <small>Failed attempts</small>
            </span>
            <span>
              <strong>{counts.pending}</strong>
              <small>Pending</small>
            </span>
            <span>
              <strong>{counts.dead}</strong>
              <small>Dead</small>
            </span>
          </div>
        </div>
      ))}
      <p className="li-hint">
        {stats.consecutiveFailures} consecutive failed attempts · last error{' '}
        {reasonLabel(stats.lastFailureCode)}
        {stats.lastSuccessAt ? ` · last success ${relativeTime(stats.lastSuccessAt)}` : ''}
      </p>

      {attempts.length === 0 ? (
        <p className="li-hint">No delivery attempts yet.</p>
      ) : (
        <div className="li-table-scroll">
          <table className="li-table">
            <caption className="li-hint">
              Recent attempts (response bodies are never stored)
            </caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Outcome</th>
                <th scope="col">HTTP</th>
                <th scope="col">Latency</th>
                <th scope="col">Reason</th>
                <th scope="col">Attempt</th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((attempt) => (
                <tr key={attempt.id}>
                  <td>{relativeTime(attempt.attemptedAt)}</td>
                  <td>
                    <span
                      className={`status-pill ${
                        attempt.outcome === 'delivered'
                          ? 'ok'
                          : attempt.outcome === 'blocked'
                            ? 'fail'
                            : 'warn'
                      }`}
                    >
                      {attempt.outcome}
                    </span>
                  </td>
                  <td>{attempt.httpStatus ?? '—'}</td>
                  <td>{attempt.latencyMs === null ? '—' : `${attempt.latencyMs} ms`}</td>
                  <td>{reasonLabel(attempt.reasonCode)}</td>
                  <td>
                    {attempt.attemptSeries > 0 ? `Replay ${attempt.attemptSeries} · ` : ''}#
                    {attempt.attemptNumber}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detail.dead.length > 0 && (
        <>
          <div className="capture-row-actions">
            <Button
              disabled={!subscription.active || busy === `replay:${subscription.id}`}
              onClick={() => onReplay()}
            >
              <RotateCcw size={15} aria-hidden /> Replay dead deliveries
            </Button>
            <span className="li-hint">
              Oldest first, up to {OUTBOUND_WEBHOOK_REPLAY_BATCH} at a time.
            </span>
          </div>
          {!subscription.active && (
            <p className="li-hint">Resume the endpoint before replaying dead deliveries.</p>
          )}
          <div className="li-table-scroll">
            <table className="li-table">
              <caption className="li-hint">Dead-lettered deliveries</caption>
              <thead>
                <tr>
                  <th scope="col">Event</th>
                  <th scope="col">Dead since</th>
                  <th scope="col">Last reason</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {detail.dead.map((delivery) => (
                  <tr key={delivery.id}>
                    <td>
                      <code>{delivery.eventId}</code>
                    </td>
                    <td>{delivery.deadAt ? relativeTime(delivery.deadAt) : '—'}</td>
                    <td>{reasonLabel(delivery.lastReasonCode)}</td>
                    <td>
                      <Button
                        variant="ghost"
                        aria-label={`Replay delivery for event ${delivery.eventId}`}
                        disabled={!subscription.active || busy === `replay:${delivery.id}`}
                        onClick={() => onReplay(delivery.id)}
                      >
                        <RotateCcw size={14} aria-hidden /> Replay
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
