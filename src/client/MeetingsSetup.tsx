import { useEffect, useState } from 'react';
import { CalendarClock, Copy, KeyRound, LoaderCircle } from 'lucide-react';
import {
  createProviderWebhook,
  draftProviderWebhook,
  getMeetingsSetup,
  getProviderWebhooks,
  getPublicConfig,
  removeProviderWebhook,
  saveBookingLink,
  setProviderWebhookStatus,
  type MeetingsSetupState,
  type ProviderWebhookEndpointSummary
} from './api';
import { useIsWorkspaceOwner } from './auth-client';
import { errorMessage } from './LinkedInSafety';
import { relativeTime } from './LinkedInScreen';
import {
  WebhookEndpointRow,
  copyText,
  providerWebhookUrl,
  type WebhookLoadState
} from './provider-webhook-view';
import { ConfirmDrawer } from './ui/dialog';
import { Button, Field, Input } from './ui/primitives';
import './lead-capture.css';

/** One sentence about the calendar connection, never a silent zero. */
function calendarStatusText(calendar: MeetingsSetupState['googleCalendar']): string {
  if (!calendar.status)
    return 'Not connected. Connect Google Calendar under Setup → Workspace to bring in meetings with people already in Trevra.';
  if (!calendar.connected)
    return `Connection status: ${calendar.status}. Reconnect it under Setup → Workspace; no meetings arrive until then.`;
  if (calendar.lastError) return `Connected. The last sync reported: ${calendar.lastError}`;
  return calendar.lastSyncedAt
    ? `Connected. Last sync ${relativeTime(calendar.lastSyncedAt)}.`
    : 'Connected. No sync has finished yet.';
}

/**
 * The booking link sequences insert, the calendar connection, and Cal.com.
 * Every member sees the link and a content-free connection status; only the
 * owner edits the link or manages Cal.com webhooks (whose reads are owner-only).
 */
export function MeetingsSetup({ setToast }: { setToast: (message: string) => void }) {
  const isOwner = useIsWorkspaceOwner();
  const [setup, setSetup] = useState<MeetingsSetupState | null>(null);
  const [load, setLoad] = useState<WebhookLoadState>('pending');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  const reload = () => {
    setLoad('pending');
    setProblem('');
    void getMeetingsSetup()
      .then((next) => {
        setSetup(next);
        setDraft(next.bookingUrl ?? '');
        setLoad('ok');
      })
      .catch((error) => {
        setProblem(errorMessage(error, 'Unable to load meetings setup.'));
        setLoad('error');
      });
  };

  useEffect(reload, []);

  const saveLink = async (value: string | null) => {
    setBusy(true);
    setProblem('');
    try {
      const saved = await saveBookingLink(value);
      setSetup((current) => (current ? { ...current, bookingUrl: saved.bookingUrl } : current));
      setDraft(saved.bookingUrl ?? '');
      setToast(saved.bookingUrl ? 'Booking link saved.' : 'Booking link removed.');
    } catch (error) {
      setProblem(errorMessage(error, 'Unable to save the booking link.'));
    } finally {
      setBusy(false);
    }
  };

  const savedLink = setup?.bookingUrl ?? '';

  return (
    <section className="page-panel" id="meetings">
      <div className="section-heading">
        <div>
          <h3>Meetings</h3>
          <p>
            Booked and calendar meetings move the matching Opportunity to Meeting and appear on
            Today.
          </p>
        </div>
        <CalendarClock size={20} aria-hidden />
      </div>
      {problem && (
        <div className="error-banner" role="alert">
          {problem}
        </div>
      )}
      {load === 'pending' && <p className="li-hint">Loading…</p>}
      {load === 'error' && (
        <div className="capture-actions">
          <Button onClick={reload}>Try again</Button>
        </div>
      )}

      {setup && (
        <>
          <h4>Booking link</h4>
          <p className="li-hint">
            Sequences insert it with {'{{booking_link}}'}. A sequence that uses it will not start,
            and holds instead of sending, while this is empty.
          </p>
          {isOwner ? (
            <div className="capture-create-row">
              <Field
                label="Booking link"
                hint="A full https:// address, for example https://cal.com/you/intro."
              >
                <Input
                  type="url"
                  value={draft}
                  maxLength={500}
                  autoComplete="url"
                  placeholder="https://cal.com/you/intro"
                  onChange={(event) => setDraft(event.target.value)}
                />
              </Field>
              <Button
                variant="primary"
                disabled={busy || draft.trim() === savedLink}
                onClick={() => void saveLink(draft.trim() || null)}
              >
                {busy && <LoaderCircle className="spin" size={15} aria-hidden />}
                Save link
              </Button>
              {savedLink && (
                <Button variant="ghost" disabled={busy} onClick={() => void saveLink(null)}>
                  Remove
                </Button>
              )}
            </div>
          ) : (
            <p>{savedLink || 'No booking link yet. The workspace owner can add one here.'}</p>
          )}

          <h4>Google Calendar</h4>
          <p className="li-hint">{calendarStatusText(setup.googleCalendar)}</p>
        </>
      )}

      <h4>Cal.com</h4>
      {isOwner ? (
        <CalcomWebhooks setToast={setToast} />
      ) : setup ? (
        <p className="li-hint">
          {setup.calcomConnected
            ? 'Cal.com webhook is set up.'
            : 'Not connected. The workspace owner can connect Cal.com here.'}
        </p>
      ) : null}
    </section>
  );
}

/**
 * Owner-only Cal.com webhooks through the shared provider-webhook routes. Trevra
 * generates the signing secret and shows it exactly once, at creation.
 */
function CalcomWebhooks({ setToast }: { setToast: (message: string) => void }) {
  const [endpoints, setEndpoints] = useState<ProviderWebhookEndpointSummary[]>([]);
  const [available, setAvailable] = useState(false);
  const [custody, setCustody] = useState(true);
  const [load, setLoad] = useState<WebhookLoadState>('pending');
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [revealed, setRevealed] = useState<{
    endpointId: string;
    path: string;
    secret: string;
  } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<ProviderWebhookEndpointSummary | null>(null);
  const [busy, setBusy] = useState('');
  const [problem, setProblem] = useState('');
  const [copyFailed, setCopyFailed] = useState(false);

  const reload = () => {
    setLoad('pending');
    setProblem('');
    // A public-config failure only costs the URL base, which falls back to the current origin.
    const config = getPublicConfig().catch(() => null);
    void Promise.all([getProviderWebhooks(), config])
      .then(([result, publicConfig]) => {
        setEndpoints(result.endpoints.filter((endpoint) => endpoint.provider === 'calcom'));
        setAvailable(result.providers.includes('calcom'));
        setCustody(result.secretsConfigured);
        setApiBaseUrl(publicConfig?.apiBaseUrl || window.location.origin);
        setLoad('ok');
      })
      .catch((error) => {
        setProblem(errorMessage(error, 'Unable to load Cal.com webhooks.'));
        setLoad('error');
      });
  };

  useEffect(reload, []);

  const base = apiBaseUrl || window.location.origin;

  const connect = async () => {
    setBusy('connect');
    setProblem('');
    setCopyFailed(false);
    try {
      const draft = await draftProviderWebhook('calcom');
      const created = await createProviderWebhook({
        provider: 'calcom',
        endpointId: draft.endpointId
      });
      setEndpoints((current) => [
        created.endpoint,
        ...current.filter((item) => item.id !== created.endpoint.id)
      ]);
      if (created.secret) {
        setRevealed({
          endpointId: created.endpoint.id,
          path: created.endpoint.path,
          secret: created.secret
        });
        setToast('Cal.com webhook created. Copy the signing secret now.');
      } else {
        setProblem(
          'Trevra did not return a signing secret for this webhook. Remove it and connect again.'
        );
      }
    } catch (error) {
      // The create may have committed with its response lost: reload so an orphan
      // endpoint shows up and can be removed. reload() clears the problem first.
      reload();
      setProblem(errorMessage(error, 'Unable to create the Cal.com webhook.'));
    } finally {
      setBusy('');
    }
  };

  const toggle = async (endpoint: ProviderWebhookEndpointSummary) => {
    setBusy(endpoint.id);
    setProblem('');
    try {
      const next = await setProviderWebhookStatus(
        endpoint.id,
        endpoint.status === 'active' ? 'disabled' : 'active'
      );
      setEndpoints((current) => current.map((item) => (item.id === next.id ? next : item)));
      setToast(next.status === 'active' ? 'Cal.com webhook resumed.' : 'Cal.com webhook paused.');
    } catch (error) {
      setProblem(errorMessage(error, 'Unable to change the Cal.com webhook.'));
    } finally {
      setBusy('');
    }
  };

  const remove = async (endpoint: ProviderWebhookEndpointSummary) => {
    setBusy(endpoint.id);
    setProblem('');
    try {
      await removeProviderWebhook(endpoint.id);
      setEndpoints((current) => current.filter((item) => item.id !== endpoint.id));
      setRevealed((current) => (current?.endpointId === endpoint.id ? null : current));
      setConfirmRemove(null);
      setToast('Cal.com webhook removed. Delete it in Cal.com too.');
    } catch (error) {
      setProblem(errorMessage(error, 'Unable to remove the Cal.com webhook.'));
    } finally {
      setBusy('');
    }
  };

  const copy = (text: string, done: string) => {
    setCopyFailed(false);
    void copyText(text).then((copied) => (copied ? setToast(done) : setCopyFailed(true)));
  };

  const revealedUrl = revealed ? providerWebhookUrl(base, revealed.path) : '';

  return (
    <>
      <p className="li-hint">
        Bookings made on your Cal.com pages move the matching Opportunity to Meeting.
      </p>
      {problem && (
        <div className="error-banner" role="alert">
          {problem}
        </div>
      )}
      {load === 'ok' && !custody && (
        <div className="error-banner" role="status">
          This server has no TREVRA_SECRETS_KEY configured, so it cannot keep a Cal.com signing
          secret yet.
        </div>
      )}
      {load === 'error' && (
        <div className="capture-actions">
          <Button onClick={reload}>Try again</Button>
        </div>
      )}
      {load === 'ok' && !available && (
        <p className="li-hint">Cal.com webhooks are not available on this deployment.</p>
      )}

      {revealed && (
        <div className="capture-webhook-connect">
          <ol className="capture-webhook-steps">
            <li>
              In Cal.com, open Settings → Developer → Webhooks and add a webhook with this
              subscriber URL.
            </li>
            <li>Paste the signing secret into the webhook's Secret field.</li>
            <li>
              Tick Booking Created, Booking Rescheduled and Booking Cancelled, and leave the payload
              template empty.
            </li>
          </ol>
          <div className="capture-secret">
            <strong>Subscriber URL</strong>
            <code>{revealedUrl}</code>
            <strong>Signing secret — shown only now</strong>
            <code>{revealed.secret}</code>
            <p className="li-hint">
              Copy it now. Trevra stores it encrypted and you won't see it again; if you lose it,
              remove this webhook and connect again.
            </p>
            <div className="capture-actions">
              <Button onClick={() => copy(revealedUrl, 'Subscriber URL copied.')}>
                <Copy size={14} aria-hidden /> Copy URL
              </Button>
              <Button onClick={() => copy(revealed.secret, 'Signing secret copied.')}>
                <Copy size={14} aria-hidden /> Copy secret
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setRevealed(null);
                  setCopyFailed(false);
                }}
              >
                I've saved it
              </Button>
            </div>
            {copyFailed && (
              <div className="error-banner" role="status">
                Copy failed — select the text and copy it manually.
              </div>
            )}
          </div>
        </div>
      )}

      {endpoints.map((endpoint) => (
        <WebhookEndpointRow
          key={endpoint.id}
          providerLabel="Cal.com"
          endpoint={endpoint}
          url={providerWebhookUrl(base, endpoint.path)}
          lastDelivery={endpoint.lastSeenAt ? relativeTime(endpoint.lastSeenAt) : 'None yet'}
          busy={busy === endpoint.id}
          onToggle={() => void toggle(endpoint)}
          onRemove={() => setConfirmRemove(endpoint)}
        />
      ))}

      {load === 'ok' && available && !revealed && (
        <div className="capture-actions">
          <Button disabled={!custody || busy === 'connect'} onClick={() => void connect()}>
            {busy === 'connect' ? (
              <LoaderCircle className="spin" size={15} aria-hidden />
            ) : (
              <KeyRound size={15} aria-hidden />
            )}
            {endpoints.length === 0 ? 'Connect Cal.com' : 'Connect another Cal.com webhook'}
          </Button>
        </div>
      )}

      {confirmRemove && (
        <ConfirmDrawer
          title="Stop listening to Cal.com?"
          tone="danger"
          body={
            <p>
              Trevra will reject Cal.com deliveries to this URL and forget its signing secret.
              Meetings already recorded stay. Delete the webhook in Cal.com as well.
            </p>
          }
          confirmLabel="Remove Cal.com webhook"
          busy={busy === confirmRemove.id}
          onConfirm={() => void remove(confirmRemove)}
          onCancel={() => setConfirmRemove(null)}
        />
      )}
    </>
  );
}
