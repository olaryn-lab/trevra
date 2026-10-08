import { useEffect, useState } from 'react';
import { Check, Copy, RefreshCw } from 'lucide-react';
import {
  connectCitationSource,
  getCitationSource,
  rotateCaptureSourceSecret,
  type CitationSourceSummary
} from '../api';
import { useWorkspaceRole } from '../auth-client';
import { errorMessage } from '../LinkedInSafety';
import { OwnerOnlyNote } from '../ui/forms';
import { Button, Field, Input, Textarea } from '../ui/primitives';
import { citationSourceStatus } from './researchFormat';

/**
 * Progressive disclosure for one watch's AI-answer citation source. Closed by
 * default: most founders never open it, and the mention list stays the focus.
 */
export function CitationSourceSetup({
  watchId,
  setToast
}: {
  watchId: string;
  setToast: (message: string) => void;
}) {
  // While the role is pending neither the form nor the member line render.
  const role = useWorkspaceRole();
  const [source, setSource] = useState<CitationSourceSummary | null>(null);
  const [loaded, setLoaded] = useState(false);
  // A failed read is not "Not connected": Connect stays off until a retry succeeds.
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [domains, setDomains] = useState('');
  const [secret, setSecret] = useState('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<'' | 'connect' | 'rotate'>('');
  const [problem, setProblem] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setLoadFailed(false);
    setSource(null);
    setSecret('');
    setDomains('');
    setProblem('');
    void getCitationSource(watchId)
      .then((next) => {
        if (cancelled) return;
        setSource(next);
        setDomains(next?.ownedDomains.join('\n') ?? '');
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setProblem(errorMessage(error, 'AI-answer citations could not be loaded.'));
        setLoadFailed(true);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [watchId, attempt]);

  const ownedDomains = [
    ...new Set(
      domains
        .split(/[\s,]+/)
        .map((domain) => domain.trim().toLowerCase())
        .filter(Boolean)
    )
  ];
  const tooMany = ownedDomains.length > 20;

  const connect = async () => {
    setBusy('connect');
    setProblem('');
    try {
      const result = await connectCitationSource(watchId, ownedDomains);
      setSource(result.citationSource);
      if (result.secret) {
        setSecret(result.secret);
        setCopied(false);
      }
      setToast(
        result.secret
          ? 'Citation source connected. Copy the signing secret now.'
          : 'Owned domains saved.'
      );
    } catch (error) {
      setProblem(errorMessage(error, 'The citation source could not be saved.'));
    } finally {
      setBusy('');
    }
  };

  const rotate = async () => {
    if (!source) return;
    setBusy('rotate');
    setProblem('');
    try {
      const rotated = await rotateCaptureSourceSecret(source.sourceId);
      setSecret(rotated.secret);
      setCopied(false);
      setToast('Signing secret rotated. The previous secret remains valid briefly.');
    } catch (error) {
      setProblem(errorMessage(error, 'The signing secret could not be rotated.'));
    } finally {
      setBusy('');
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      setProblem('Copy failed. Select the secret and copy it by hand.');
    }
  };

  return (
    <details className="research-citation-setup">
      <summary className="ui-disclosure-summary">
        AI-answer citations{loadFailed ? ' · could not load' : ''}
      </summary>
      <p className="research-citation-status">
        {!loaded
          ? 'Loading…'
          : loadFailed
            ? 'The citation source could not be read, so connecting is off until it loads.'
            : source
              ? citationSourceStatus(source, new Date())
              : 'Not connected. Beseam, or any sampler that can sign requests, posts content-free samples of whether AI answers cite your site.'}
      </p>
      {problem && (
        <div className="error-banner" role="alert">
          {problem}
        </div>
      )}
      {loadFailed && (
        <div className="research-citation-actions">
          <Button onClick={() => setAttempt((current) => current + 1)}>Try again</Button>
        </div>
      )}
      {role === 'owner' ? (
        <div className="research-citation-form">
          <Field
            label="Domains you own"
            hint={
              tooMany
                ? 'At most 20 domains.'
                : 'One per line, up to 20. Only citations of these domains and their subdomains are accepted.'
            }
          >
            <Textarea
              rows={3}
              value={domains}
              placeholder="example.com"
              onChange={(event) => setDomains(event.target.value)}
            />
          </Field>
          <div className="research-citation-actions">
            <Button
              variant="primary"
              disabled={
                !loaded || loadFailed || busy !== '' || ownedDomains.length === 0 || tooMany
              }
              onClick={() => void connect()}
            >
              {busy === 'connect' ? 'Saving…' : source ? 'Save domains' : 'Connect'}
            </Button>
            {source && (
              <Button disabled={busy !== ''} onClick={() => void rotate()}>
                <RefreshCw size={15} />
                {busy === 'rotate' ? 'Rotating…' : 'Rotate secret'}
              </Button>
            )}
          </div>
        </div>
      ) : role === 'member' ? (
        <OwnerOnlyNote>connect a citation source</OwnerOnlyNote>
      ) : null}
      {source && (
        <dl className="research-citation-facts">
          <dt>Source ID</dt>
          <dd>
            <code>{source.sourceId}</code>
          </dd>
          <dt>Endpoint</dt>
          <dd>
            <code>POST /api/intake/v1/citations</code>
          </dd>
        </dl>
      )}
      {secret && (
        <div className="research-citation-secret ui-field-row">
          <Field
            label="Signing secret"
            hint="Shown once. Keep it in the sampler's server-side secrets."
          >
            <Input readOnly value={secret} onFocus={(event) => event.currentTarget.select()} />
          </Field>
          <Button aria-label="Copy signing secret" onClick={() => void copy()}>
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </Button>
        </div>
      )}
    </details>
  );
}
