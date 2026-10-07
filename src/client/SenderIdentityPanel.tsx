import { useEffect, useState } from 'react';
import { Mail } from 'lucide-react';
import type { SenderIdentity } from '../server/compliance/sender-identity';
import { getSenderIdentity, saveSenderIdentity } from './api';
import { errorMessage } from './LinkedInSafety';
import { ActionRow, FormGrid } from './ui/forms';
import { Panel } from './ui/layout';
import { Button, Field, Input, Textarea } from './ui/primitives';

export interface SenderIdentityDraft {
  legalName: string;
  postalAddress: string;
  privacyPolicyUrl: string;
}

export function draftFromIdentity(identity: SenderIdentity): SenderIdentityDraft {
  return {
    legalName: identity.legalName ?? '',
    postalAddress: identity.postalAddress ?? '',
    privacyPolicyUrl: identity.privacyPolicyUrl ?? ''
  };
}

/** What blocks email outreach right now, from the SAVED identity. */
export function senderIdentityGaps(identity: SenderIdentity): string[] {
  return [
    identity.postalAddress ? null : 'postal address',
    identity.privacyPolicyUrl ? null : 'privacy policy URL'
  ].filter((gap): gap is string => gap !== null);
}

export function draftToSenderIdentityInput(draft: SenderIdentityDraft) {
  const value = (text: string) => (text.trim() ? text.trim() : null);
  return {
    legalName: value(draft.legalName),
    postalAddress: value(draft.postalAddress),
    privacyPolicyUrl: value(draft.privacyPolicyUrl)
  };
}

export function SenderIdentityForm({
  draft,
  onChange,
  onSave,
  busy,
  isOwner,
  error,
  gaps
}: {
  draft: SenderIdentityDraft;
  onChange: (patch: Partial<SenderIdentityDraft>) => void;
  onSave: () => void;
  busy: boolean;
  isOwner: boolean;
  error: string;
  /** Null until the saved identity has loaded: never claim Complete before knowing. */
  gaps: string[] | null;
}) {
  return (
    <Panel
      title="Sender identity"
      description="Who your outreach email says it is from. Every outreach email ends with a footer built from these details, and email outreach stays blocked until the postal address and privacy policy URL are set."
      icon={<Mail size={18} />}
      actions={
        gaps === null ? undefined : (
          <span className="status-pill">
            {gaps.length > 0 ? 'Email outreach blocked' : 'Complete'}
          </span>
        )
      }
    >
      {gaps && gaps.length > 0 && <p className="li-hint">Missing: {gaps.join(' and ')}.</p>}
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      <FormGrid>
        <Field label="Legal name">
          <Input
            value={draft.legalName}
            disabled={!isOwner || busy}
            maxLength={200}
            onChange={(event) => onChange({ legalName: event.target.value })}
          />
        </Field>
        <Field label="Postal address" hint="A street address or a registered post office box.">
          <Textarea
            rows={3}
            value={draft.postalAddress}
            disabled={!isOwner || busy}
            maxLength={500}
            onChange={(event) => onChange({ postalAddress: event.target.value })}
          />
        </Field>
        <Field label="Privacy policy URL">
          <Input
            type="url"
            inputMode="url"
            placeholder="https://"
            value={draft.privacyPolicyUrl}
            disabled={!isOwner || busy}
            maxLength={2048}
            onChange={(event) => onChange({ privacyPolicyUrl: event.target.value })}
          />
        </Field>
      </FormGrid>
      {isOwner ? (
        <ActionRow note="Emails prepared before a change will not send. Prepare them again after saving.">
          <Button variant="primary" disabled={busy} onClick={onSave}>
            {busy ? 'Saving…' : 'Save sender identity'}
          </Button>
        </ActionRow>
      ) : (
        <p className="li-hint">Only the workspace owner can change the sender identity.</p>
      )}
    </Panel>
  );
}

export function SenderIdentityPanel({
  setToast,
  isOwner
}: {
  setToast: (message: string) => void;
  isOwner: boolean;
}) {
  const [saved, setSaved] = useState<SenderIdentity | null>(null);
  const [draft, setDraft] = useState<SenderIdentityDraft>({
    legalName: '',
    postalAddress: '',
    privacyPolicyUrl: ''
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    getSenderIdentity()
      .then((identity) => {
        if (!live) return;
        setSaved(identity);
        setDraft(draftFromIdentity(identity));
      })
      .catch((cause: unknown) => {
        if (live) setError(errorMessage(cause, 'Unable to read the sender identity.'));
      });
    return () => {
      live = false;
    };
  }, []);

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const identity = await saveSenderIdentity(draftToSenderIdentityInput(draft));
      setSaved(identity);
      setDraft(draftFromIdentity(identity));
      setToast('Sender identity saved.');
    } catch (cause) {
      setError(errorMessage(cause, 'Unable to save the sender identity.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SenderIdentityForm
      draft={draft}
      onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
      onSave={() => void save()}
      busy={busy || saved === null}
      isOwner={isOwner}
      error={error}
      gaps={saved ? senderIdentityGaps(saved) : null}
    />
  );
}
