import { useEffect, useState } from 'react';
import { CircleAlert, LoaderCircle, X } from 'lucide-react';
import { getIntegrations, prepareCrmContactUpsert, type CrmContactUpsert } from './api';
import type { ConnectionSummary, PlaybookRun } from '../shared/types';
import { errorMessage } from './LinkedInSafety';
import { Button, Field, Select } from './ui/primitives';

/**
 * TRV-051 "Sync to CRM" for one lead.
 *
 * Preparing reads the CRM and writes nothing. It shows how the contact was
 * matched, which empty fields would be filled, what the CRM keeps, and any
 * ambiguity; the write itself is approved on the run's ledger page.
 */

const FIELD_LABELS: Record<string, string> = {
  firstName: 'First name',
  lastName: 'Last name',
  email: 'Email',
  company: 'Company',
  title: 'Title',
  linkedinUrl: 'LinkedIn URL',
  phone: 'Phone'
};

const TIER_LABELS: Record<string, string> = {
  crm_link: 'the record already linked to this lead',
  linkedin_url: 'LinkedIn URL',
  email: 'email',
  name_company: 'name and company',
  none: 'no match'
};

const OUTCOME_LABELS: Record<string, string> = {
  matched: 'matched',
  no_match: 'no match',
  no_key: 'not on this lead',
  ambiguous: 'several matches',
  deleted: 'deleted in the CRM',
  merged: 'merged in the CRM'
};

const SKIP_LABELS: Record<string, string> = {
  not_writable: 'this CRM keeps it as a linked record, so Trevra does not write it',
  phone_not_e164: 'needs an international number with a + country code',
  email_never_written: 'email is never added to an existing contact'
};

const PROVIDER_LABELS: Record<string, string> = { hubspot: 'HubSpot', attio: 'Attio' };

const label = (map: Record<string, string>, key: string) => map[key] ?? key;

function usableCrm(connection: ConnectionSummary): boolean {
  return (
    (connection.provider === 'hubspot' || connection.provider === 'attio') &&
    connection.status === 'connected' &&
    !connection.isDemo
  );
}

function headline(upsert: CrmContactUpsert, provider: string): string {
  if (upsert.status === 'blocked_ambiguous') return 'Blocked: more than one CRM contact matches';
  if (upsert.status === 'up_to_date') return `Already up to date in ${provider}`;
  if (upsert.status === 'succeeded') return `Synced to ${provider}`;
  if (upsert.status === 'executing') return 'Sync in progress';
  return upsert.operation === 'create'
    ? `No ${provider} contact matches — approving creates one`
    : `Matched by ${label(TIER_LABELS, upsert.matchTier)} — approving fills empty fields only`;
}

/** The run to approve on the ledger, only while it is actually waiting for a decision. */
export function crmUpsertApprovalRunId(
  upsert: CrmContactUpsert,
  run: PlaybookRun | null
): string | null {
  return upsert.status === 'prepared' && run?.status === 'waiting_approval' ? run.id : null;
}

/** What a prepared upsert would do: match, planned fields, conflicts, ambiguity. */
export function CrmUpsertReview({
  upsert,
  provider
}: {
  upsert: CrmContactUpsert;
  provider: string;
}) {
  const planned = Object.entries(upsert.plan.fields);
  return (
    <>
      <div role="status">
        <p>
          <strong>{headline(upsert, provider)}</strong>
        </p>
        {upsert.plan.tiersSearched.length > 0 ? (
          <p className="li-hint">
            Searched:{' '}
            {upsert.plan.tiersSearched
              .map(
                (step) =>
                  `${label(TIER_LABELS, step.tier)} (${label(OUTCOME_LABELS, step.outcome)})`
              )
              .join(', ')}
          </p>
        ) : null}
      </div>

      {upsert.status === 'blocked_ambiguous' ? (
        <div className="li-warn-block">
          <CircleAlert size={15} />
          <div>
            <strong>
              {upsert.plan.candidates.length} {provider} contacts match on{' '}
              {label(TIER_LABELS, upsert.matchTier)}. Nothing will be written.
            </strong>
            <ul>
              {upsert.plan.candidates.map((candidate) => (
                <li key={candidate.id}>
                  {candidate.label ?? 'Unnamed contact'} · record {candidate.id}
                </li>
              ))}
            </ul>
            <p className="li-hint">
              Merge or fix the duplicates in {provider}, then prepare again.
            </p>
          </div>
        </div>
      ) : null}

      {planned.length > 0 && upsert.status !== 'blocked_ambiguous' ? (
        <div className="li-table-scroll">
          <table className="li-table">
            <caption className="mgr-sr">Fields Trevra would write</caption>
            <thead>
              <tr>
                <th>
                  {upsert.operation === 'create' ? 'New contact field' : 'Empty field to fill'}
                </th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {planned.map(([field, value]) => (
                <tr key={field}>
                  <td>{label(FIELD_LABELS, field)}</td>
                  <td>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {upsert.plan.conflicts.length > 0 ? (
        <div>
          <strong>{provider} keeps its own value</strong>
          <ul>
            {upsert.plan.conflicts.map((conflict) => (
              <li key={conflict.field}>
                {label(FIELD_LABELS, conflict.field)}: CRM has “{conflict.crmValue}”, Trevra has “
                {conflict.trevraValue}”
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {upsert.plan.skipped.length > 0 ? (
        <div>
          <strong>Not written</strong>
          <ul>
            {upsert.plan.skipped.map((skip) => (
              <li key={skip.field}>
                {label(FIELD_LABELS, skip.field)}: {label(SKIP_LABELS, skip.reason)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

export function CrmContactSync({
  leadContactId,
  leadName,
  onClose
}: {
  leadContactId: string;
  leadName: string;
  onClose: () => void;
}) {
  const [connections, setConnections] = useState<ConnectionSummary[] | null>(null);
  const [connectionId, setConnectionId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{
    upsert: CrmContactUpsert;
    run: PlaybookRun | null;
  } | null>(null);

  useEffect(() => {
    let live = true;
    getIntegrations()
      .then(({ connections: all }) => {
        if (!live) return;
        const usable = all.filter(usableCrm);
        setConnections(usable);
        setConnectionId(usable[0]?.id ?? '');
      })
      .catch((cause) => {
        if (live) setError(errorMessage(cause, 'Could not read connected CRMs.'));
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    setResult(null);
    setError('');
  }, [leadContactId]);

  async function prepare() {
    setBusy(true);
    setError('');
    try {
      setResult(
        await prepareCrmContactUpsert({
          leadContactId,
          ...(connectionId ? { connectionId } : {})
        })
      );
    } catch (cause) {
      setResult(null);
      setError(errorMessage(cause, 'Could not prepare the CRM sync. Nothing was written.'));
    } finally {
      setBusy(false);
    }
  }

  const connection = connections?.find((item) => item.id === connectionId) ?? null;
  const provider = label(PROVIDER_LABELS, result?.upsert.provider ?? connection?.provider ?? '');
  const upsert = result?.upsert ?? null;
  const approvalRunId = result ? crmUpsertApprovalRunId(result.upsert, result.run) : null;

  return (
    <section className="lead-editor" aria-label={`Sync ${leadName} to CRM`}>
      <div className="mgr-actions">
        <h4>Sync {leadName} to CRM</h4>
        <Button variant="ghost" aria-label="Close CRM sync" onClick={onClose}>
          <X size={14} />
        </Button>
      </div>
      <p className="li-hint">
        Trevra searches the CRM by LinkedIn URL, then email, then name and company. It never
        overwrites a value the CRM already has, and nothing is written until you approve it.
      </p>

      {connections === null && !error ? (
        <p className="li-hint" role="status">
          Checking connected CRMs…
        </p>
      ) : null}
      {connections?.length === 0 ? (
        <p className="li-hint">
          No CRM is connected. Connect HubSpot or Attio in <a href="/setup">Setup</a>, with contact
          read and write access.
        </p>
      ) : null}
      {connections && connections.length > 1 ? (
        <Field label="CRM">
          <Select
            value={connectionId}
            disabled={busy}
            onChange={(event) => {
              setConnectionId(event.target.value);
              setResult(null);
            }}
          >
            {connections.map((item) => (
              <option key={item.id} value={item.id}>
                {label(PROVIDER_LABELS, item.provider)}
                {item.displayName ? ` · ${item.displayName}` : ''}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      {error ? (
        <div className="error-banner" role="alert">
          {error}
        </div>
      ) : null}

      {upsert ? <CrmUpsertReview upsert={upsert} provider={provider} /> : null}

      <div className="mgr-actions">
        {approvalRunId ? (
          <a className="primary-button" href={`/ledger/run/${encodeURIComponent(approvalRunId)}`}>
            Review and approve
          </a>
        ) : null}
        {connections && connections.length > 0 ? (
          <Button
            variant={upsert ? 'secondary' : 'primary'}
            disabled={busy || !connectionId}
            onClick={() => void prepare()}
          >
            {busy ? <LoaderCircle className="spin" size={14} /> : null}
            {busy ? 'Searching the CRM…' : upsert ? 'Prepare again' : 'Prepare CRM sync'}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
