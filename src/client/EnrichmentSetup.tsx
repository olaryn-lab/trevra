import { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import {
  deleteHunterKey,
  getEnrichment,
  saveEnrichmentCap,
  saveHunterKey,
  type EnrichmentSettings,
  type EnrichmentUsage
} from './api';
import { authClient, useIsWorkspaceOwner } from './auth-client';
import { errorMessage } from './LinkedInSafety';
import { Panel } from './ui/layout';
import { ConfirmDrawer } from './ui/dialog';
import { Button, Field, Input } from './ui/primitives';
import { keyStatusLine, parseCreditCap, usageLine } from './views/planCost';

export function EnrichmentSetup({ setToast }: { setToast: (message: string) => void }) {
  const isOwner = useIsWorkspaceOwner();
  // useIsWorkspaceOwner is false while the member read is pending; hold both
  // the owner controls and the member line until it resolves.
  const { isPending: orgPending } = authClient.useActiveOrganization();
  const { isPending: memberPending } = authClient.useActiveMember();
  const roleKnown = !orgPending && !memberPending;
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [settings, setSettings] = useState<EnrichmentSettings | null>(null);
  const [usage, setUsage] = useState<EnrichmentUsage | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [cap, setCap] = useState('');
  const [busy, setBusy] = useState<'' | 'key' | 'remove' | 'cap'>('');
  const [problem, setProblem] = useState('');

  useEffect(() => {
    let cancelled = false;
    void getEnrichment()
      .then((result) => {
        if (cancelled) return;
        setSettings(result.settings);
        setUsage(result.usage);
        setCap(String(result.settings.monthlyCreditCap));
      })
      .catch((error: unknown) => {
        if (!cancelled) setProblem(errorMessage(error, 'Enrichment settings could not be loaded.'));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const saveKey = async () => {
    setBusy('key');
    setProblem('');
    try {
      setSettings(await saveHunterKey(apiKey.trim()));
      setApiKey('');
      setToast('Hunter key checked and saved.');
    } catch (error) {
      setProblem(errorMessage(error, 'The Hunter key could not be saved.'));
    } finally {
      setBusy('');
    }
  };

  const removeKey = async () => {
    setBusy('remove');
    setProblem('');
    try {
      setSettings(await deleteHunterKey());
      setToast('Hunter key removed.');
    } catch (error) {
      setProblem(errorMessage(error, 'The Hunter key could not be removed.'));
    } finally {
      setBusy('');
      setConfirmRemove(false);
    }
  };

  const saveCap = async () => {
    const parsed = parseCreditCap(cap);
    if (!parsed.ok) {
      setProblem(parsed.message);
      return;
    }
    const value = parsed.value;
    setBusy('cap');
    setProblem('');
    try {
      const result = await saveEnrichmentCap(value);
      setSettings(result.settings);
      setUsage(result.usage);
      setCap(String(result.settings.monthlyCreditCap));
      setToast('Monthly credit cap saved.');
    } catch (error) {
      setProblem(errorMessage(error, 'The credit cap could not be saved.'));
    } finally {
      setBusy('');
    }
  };

  return (
    <Panel
      title="Contact enrichment"
      description="Find verified contacts at named accounts with your own Hunter key. Each run is approved in a plan and stops at the credits that plan showed."
      icon={<KeyRound size={18} />}
    >
      {problem && <div className="error-banner">{problem}</div>}
      {settings && usage ? (
        <div className="enrichment-setup">
          <p className="enrichment-setup-status">
            {keyStatusLine(settings)} {usageLine(settings, usage)}
          </p>
          {isOwner ? (
            <>
              <div className="enrichment-setup-row">
                <Field label="Hunter API key" hint="Stored encrypted. Trevra never shows it again.">
                  <Input
                    type="password"
                    autoComplete="off"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={
                      settings.keyStatus === 'missing'
                        ? 'Paste your key'
                        : 'Paste a new key to replace it'
                    }
                  />
                </Field>
                <Button
                  variant="primary"
                  disabled={busy !== '' || apiKey.trim().length < 8}
                  onClick={() => void saveKey()}
                >
                  {busy === 'key' ? 'Checking…' : 'Save key'}
                </Button>
                {settings.keyStatus !== 'missing' && (
                  <Button
                    variant="danger"
                    disabled={busy !== ''}
                    onClick={() => setConfirmRemove(true)}
                  >
                    {busy === 'remove' ? 'Removing…' : 'Remove key'}
                  </Button>
                )}
              </div>
              <div className="enrichment-setup-row">
                <Field
                  label="Monthly credit cap"
                  hint="0 turns enrichment off. Hunter's free plan includes 50 credits a month."
                >
                  <Input
                    type="number"
                    min={0}
                    max={100000}
                    step={0.5}
                    inputMode="decimal"
                    value={cap}
                    onChange={(event) => setCap(event.target.value)}
                  />
                </Field>
                <Button
                  disabled={busy !== '' || cap === String(settings.monthlyCreditCap)}
                  onClick={() => void saveCap()}
                >
                  {busy === 'cap' ? 'Saving…' : 'Save cap'}
                </Button>
              </div>
            </>
          ) : roleKnown ? (
            <p className="enrichment-setup-status">
              Only the workspace owner can change the key or the cap.
            </p>
          ) : null}
        </div>
      ) : !problem ? (
        <p className="enrichment-setup-status">Loading…</p>
      ) : null}
      {confirmRemove && (
        <ConfirmDrawer
          title="Remove the Hunter key?"
          tone="danger"
          body={
            <>
              <p>
                Trevra deletes its encrypted copy of the key. Queued and running enrichment runs
                stop, and no new run can start until you save a key again.
              </p>
              <p>
                <strong>This does not revoke the key at Hunter.</strong> If it may have leaked,
                revoke it there as well.
              </p>
            </>
          }
          confirmLabel="Remove key"
          busy={busy === 'remove'}
          onCancel={() => setConfirmRemove(false)}
          onConfirm={() => void removeKey()}
        />
      )}
    </Panel>
  );
}
