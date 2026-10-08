import { useEffect, useState } from 'react';
import { Copy, CreditCard, LoaderCircle } from 'lucide-react';
import {
  createProviderWebhook,
  draftProviderWebhook,
  getProviderWebhooks,
  getPublicConfig,
  removeProviderWebhook,
  setProviderWebhookStatus,
  type ProviderWebhookEndpointSummary
} from './api';
import { Button, Field, Input } from './ui/primitives';
import { ConfirmDrawer } from './ui/dialog';
import { errorMessage } from './LinkedInSafety';
import { relativeTime } from './LinkedInScreen';
import {
  SecretCustodyNotice,
  StripeEventSelection,
  WebhookEndpointRow,
  copyText,
  providerWebhookUrl,
  showStripePanel,
  type WebhookLoadState
} from './provider-webhook-view';

const WHSEC_RE = /^whsec_\S{16,200}$/;

/**
 * Observe-only Stripe connection. The owner adds an endpoint in the Stripe
 * Dashboard with the URL shown here, then pastes the `whsec_` signing secret
 * Stripe shows for it. Trevra stores it sealed and never shows it again.
 */
export function ProviderWebhookSetup({ setToast }: { setToast: (message: string) => void }) {
  const [endpoints, setEndpoints] = useState<ProviderWebhookEndpointSummary[]>([]);
  const [available, setAvailable] = useState(false);
  const [load, setLoad] = useState<WebhookLoadState>('pending');
  const [custody, setCustody] = useState(true);
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [draft, setDraft] = useState<{ endpointId: string; path: string } | null>(null);
  const [signingSecret, setSigningSecret] = useState('');
  const [confirmRemove, setConfirmRemove] = useState<ProviderWebhookEndpointSummary | null>(null);
  const [busy, setBusy] = useState('');
  const [problem, setProblem] = useState('');
  const [copyFailed, setCopyFailed] = useState(false);

  const reload = () => {
    setLoad('pending');
    setProblem('');
    // A public-config failure only costs the URL base, which falls back to the
    // current origin; it must not hide an otherwise working panel.
    const config = getPublicConfig().catch(() => null);
    void Promise.all([getProviderWebhooks(), config])
      .then(([result, publicConfig]) => {
        setEndpoints(result.endpoints.filter((endpoint) => endpoint.provider === 'stripe'));
        setAvailable(result.providers.includes('stripe'));
        setCustody(result.secretsConfigured);
        setApiBaseUrl(publicConfig?.apiBaseUrl || window.location.origin);
        setLoad('ok');
      })
      .catch((error) => {
        setProblem(errorMessage(error, 'Unable to load Stripe payments.'));
        setLoad('error');
      });
  };

  useEffect(reload, []);

  const base = apiBaseUrl || window.location.origin;

  const start = async () => {
    setBusy('draft');
    setProblem('');
    setCopyFailed(false);
    try {
      setDraft(await draftProviderWebhook('stripe'));
    } catch (error) {
      setProblem(errorMessage(error, 'Unable to prepare a Stripe endpoint.'));
    } finally {
      setBusy('');
    }
  };

  const save = async () => {
    if (!draft) return;
    setBusy('save');
    setProblem('');
    try {
      const { endpoint } = await createProviderWebhook({
        provider: 'stripe',
        endpointId: draft.endpointId,
        signingSecret: signingSecret.trim()
      });
      setEndpoints((current) => [endpoint, ...current.filter((item) => item.id !== endpoint.id)]);
      setDraft(null);
      setSigningSecret('');
      setToast('Stripe connected. Trevra now listens for payments.');
    } catch (error) {
      setProblem(errorMessage(error, 'Unable to save the Stripe signing secret.'));
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
      setToast(next.status === 'active' ? 'Stripe endpoint resumed.' : 'Stripe endpoint paused.');
    } catch (error) {
      setProblem(errorMessage(error, 'Unable to change the Stripe endpoint.'));
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
      setConfirmRemove(null);
      setToast('Stripe endpoint removed. Delete it in Stripe too.');
    } catch (error) {
      setProblem(errorMessage(error, 'Unable to remove the Stripe endpoint.'));
    } finally {
      setBusy('');
    }
  };

  const copyUrl = (url: string) => {
    setCopyFailed(false);
    void copyText(url).then((copied) =>
      copied ? setToast('Endpoint URL copied.') : setCopyFailed(true)
    );
  };

  if (!showStripePanel(load, available)) return null;

  return (
    <section className="page-panel" id="stripe-payments">
      <div className="section-heading">
        <div>
          <h3>Stripe payments</h3>
          <p>
            Observe paid, upgraded and cancelled customers. Trevra only listens; it never changes
            anything in Stripe and never stores amounts.
          </p>
        </div>
        <CreditCard size={20} aria-hidden />
      </div>
      {problem && (
        <div className="error-banner" role="alert">
          {problem}
        </div>
      )}
      {!custody && <SecretCustodyNotice />}

      {load === 'error' && (
        <div className="capture-row-actions">
          <Button onClick={reload}>Try again</Button>
        </div>
      )}

      {endpoints.map((endpoint) => (
        <WebhookEndpointRow
          key={endpoint.id}
          endpoint={endpoint}
          url={providerWebhookUrl(base, endpoint.path)}
          lastDelivery={endpoint.lastSeenAt ? relativeTime(endpoint.lastSeenAt) : 'None yet'}
          busy={busy === endpoint.id}
          onToggle={() => void toggle(endpoint)}
          onRemove={() => setConfirmRemove(endpoint)}
        />
      ))}

      {load === 'ok' && endpoints.length === 0 && !draft && (
        <div className="capture-row-actions">
          <Button
            variant="primary"
            disabled={!custody || busy === 'draft'}
            onClick={() => void start()}
          >
            {busy === 'draft' ? (
              <LoaderCircle className="spin" size={15} aria-hidden />
            ) : (
              <CreditCard size={15} aria-hidden />
            )}
            Connect Stripe
          </Button>
        </div>
      )}

      {draft && (
        <div className="capture-webhook-connect">
          <ol className="capture-webhook-steps">
            <li>In Stripe, open Developers → Webhooks and add an endpoint with this URL.</li>
            <li>Select only these events.</li>
            <li>Reveal the endpoint's signing secret and paste it below.</li>
          </ol>
          <div className="capture-secret">
            <strong>Endpoint URL</strong>
            <code>{providerWebhookUrl(base, draft.path)}</code>
            <Button onClick={() => copyUrl(providerWebhookUrl(base, draft.path))}>
              <Copy size={14} aria-hidden /> Copy URL
            </Button>
            {copyFailed && (
              <div className="error-banner" role="status">
                Copy failed — select the URL and copy it manually.
              </div>
            )}
          </div>
          <StripeEventSelection />
          <div className="capture-webhook-form ui-field-row">
            <Field
              label="Signing secret"
              hint="Starts with whsec_. Stored encrypted and never shown again."
            >
              <Input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={signingSecret}
                placeholder="whsec_…"
                onChange={(event) => setSigningSecret(event.target.value)}
              />
            </Field>
            <Button
              variant="primary"
              disabled={!WHSEC_RE.test(signingSecret.trim()) || busy === 'save'}
              onClick={() => void save()}
            >
              {busy === 'save' && <LoaderCircle className="spin" size={15} aria-hidden />}
              Save and listen
            </Button>
          </div>
          <div className="capture-row-actions">
            <Button
              variant="ghost"
              onClick={() => {
                setDraft(null);
                setSigningSecret('');
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {confirmRemove && (
        <ConfirmDrawer
          title="Stop listening to Stripe?"
          tone="danger"
          body={
            <p>
              Trevra will reject Stripe deliveries to this URL and forget its signing secret.
              Milestones already recorded stay. Delete the endpoint in Stripe as well.
            </p>
          }
          confirmLabel="Remove Stripe endpoint"
          busy={busy === confirmRemove.id}
          onConfirm={() => void remove(confirmRemove)}
          onCancel={() => setConfirmRemove(null)}
        />
      )}
    </section>
  );
}
