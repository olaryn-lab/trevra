import { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import {
  deleteHunterKey,
  getEnrichment,
  saveEnrichmentCap,
  saveHunterKey,
  type EnrichmentRunView,
  type EnrichmentSettings,
  type EnrichmentUsage
} from './api';
import { useWorkspaceRole } from './auth-client';
import { errorMessage } from './LinkedInSafety';
import { relativeTime } from './LinkedInScreen';
import { Panel } from './ui/layout';
import { ConfirmDrawer } from './ui/dialog';
import { OwnerOnlyNote } from './ui/forms';
import { Button, Field, Input } from './ui/primitives';
import {
  keyEntryHint,
  keyStatusLine,
  MIN_HUNTER_KEY_LENGTH,
  parseCreditCap,
  runCompaniesLine,
  runContactsLine,
  runCreditsLine,
  runStatusLabel,
  usageLine
} from './views/planCost';

export function EnrichmentSetup({ setToast }: { setToast: (message: string) => void }) {
  // While the role is pending neither the owner controls nor the member line render.
  const role = useWorkspaceRole();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [settings, setSettings] = useState<EnrichmentSettings | null>(null);
  const [usage, setUsage] = useState<EnrichmentUsage | null>(null);
  // Null until loaded: a failed load shows the error banner, never "no runs".
  const [runs, setRuns] = useState<EnrichmentRunView[] | null>(null);
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
        setRuns(result.runs);
        setCap(String(result.settings.monthlyCreditCap));
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setProblem(errorMessage(error, 'Enrichment settings and runs could not be loaded.'));
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
      {problem && (
        <div className="error-banner" role="alert">
          {problem}
        </div>
      )}
      {settings && usage ? (
        <div className="enrichment-setup">
          <p className="enrichment-setup-status">
            {keyStatusLine(settings)} {usageLine(settings, usage)}
          </p>
          {role === 'owner' ? (
            <>
              <div className="enrichment-setup-row ui-field-row">
                <Field label="Hunter API key" hint={keyEntryHint(apiKey)}>
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
                  disabled={busy !== '' || apiKey.trim().length < MIN_HUNTER_KEY_LENGTH}
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
              <div className="enrichment-setup-row ui-field-row">
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
          ) : role === 'member' ? (
            <OwnerOnlyNote>change the key or the cap</OwnerOnlyNote>
          ) : null}
          {runs && (
            <section className="enrichment-runs" aria-labelledby="enrichment-runs-heading">
              <h4 id="enrichment-runs-heading" className="li-subhead" aria-level={3}>
                Recent runs
              </h4>
              {runs.length === 0 ? (
                <p className="enrichment-setup-status">No enrichment runs yet.</p>
              ) : (
                <div className="li-table-scroll">
                  <table className="li-table">
                    <thead>
                      <tr>
                        <th>Approved</th>
                        <th>Status</th>
                        <th>Companies</th>
                        <th>Contacts</th>
                        <th>Credits</th>
                      </tr>
                    </thead>
                    <tbody>
                      {runs.map((run) => (
                        <tr key={run.id}>
                          <td>
                            <time dateTime={run.createdAt} title={run.createdAt.slice(0, 10)}>
                              {relativeTime(run.createdAt)}
                            </time>
                          </td>
                          <td>
                            {runStatusLabel(run.status)}
                            {run.error && <p className="enrichment-run-error">{run.error}</p>}
                          </td>
                          <td>{runCompaniesLine(run)}</td>
                          <td>{runContactsLine(run)}</td>
                          <td>{runCreditsLine(run)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
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
