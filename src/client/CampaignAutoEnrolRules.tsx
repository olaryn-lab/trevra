import { useCallback, useEffect, useState } from 'react';
import {
  createManagedCampaignAutoEnrolRule,
  disableManagedCampaignAutoEnrolRule,
  getCaptureSources,
  getManagedCampaignAutoEnrolRules,
  type AutoEnrolRule,
  type AutoEnrolSourceKind,
  type CaptureSourceSummary
} from './api';
import { useWorkspaceCan } from './auth-client';
import { errorMessage } from './LinkedInSafety';
import { Button, Field, Select } from './ui/primitives';
import type { LinkedInLeadList } from '../server/linkedin/lead-lists';
import type { ManagedCampaign } from '../server/linkedin/managed-campaigns';

const SOURCE_LABEL: Record<AutoEnrolSourceKind, string> = {
  capture_source: 'Capture source',
  lead_list: 'Lead list'
};

/**
 * TRV-029: a capture source or another lead list that adds its new leads to
 * this campaign. Every lead goes through the same checks as adding it by hand
 * (src/server/linkedin/auto-enrol.ts); this panel only names the sources.
 */
export function CampaignAutoEnrolRules({
  campaign,
  lists
}: {
  campaign: ManagedCampaign;
  lists: readonly LinkedInLeadList[];
}) {
  // Owner or manager (`campaigns.auto_enrol`, src/server/roles.ts).
  const canManage = useWorkspaceCan('campaigns.auto_enrol');
  const [rules, setRules] = useState<AutoEnrolRule[] | null>(null);
  const [sources, setSources] = useState<CaptureSourceSummary[]>([]);
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState('');
  const [failure, setFailure] = useState('');

  const load = useCallback(async () => {
    try {
      const [nextRules, nextSources] = await Promise.all([
        getManagedCampaignAutoEnrolRules(campaign.id),
        canManage ? getCaptureSources() : Promise.resolve([])
      ]);
      setRules(nextRules);
      setSources(nextSources);
      setFailure('');
    } catch (error) {
      setFailure(errorMessage(error, 'Could not read the auto-enrol sources. Try again.'));
    }
  }, [campaign.id, canManage]);
  useEffect(() => {
    void load();
  }, [load]);

  const active = (rules ?? []).filter((rule) => rule.status === 'active');
  const taken = new Set(active.map((rule) => `${rule.sourceKind}:${rule.sourceId}`));
  const captureChoices = sources.filter(
    (source) => source.status === 'active' && !taken.has(`capture_source:${source.id}`)
  );
  const listChoices = lists.filter(
    (list) => list.id !== campaign.leadListId && !taken.has(`lead_list:${list.id}`)
  );
  const ended = campaign.status === 'stopped' || campaign.status === 'completed';

  const add = async () => {
    const split = choice.indexOf(':');
    if (split < 0) return;
    setBusy('add');
    try {
      await createManagedCampaignAutoEnrolRule(campaign.id, {
        sourceKind: choice.slice(0, split) as AutoEnrolSourceKind,
        sourceId: choice.slice(split + 1)
      });
      setChoice('');
      await load();
    } catch (error) {
      setFailure(errorMessage(error, 'Could not add that source. Nothing was changed.'));
    } finally {
      setBusy('');
    }
  };

  const disable = async (rule: AutoEnrolRule) => {
    setBusy(rule.id);
    try {
      await disableManagedCampaignAutoEnrolRule(rule.id);
      await load();
    } catch (error) {
      setFailure(errorMessage(error, 'Could not stop that source. Nothing was changed.'));
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="mgr-settings-block" aria-label="Auto-enrol new leads">
      <h4>Auto-enrol new leads</h4>
      <p className="li-hint">
        New leads from a chosen capture source or lead list join this campaign with the same checks
        as adding them by hand: suppression, Never Contact, duplicates and account limits. They are
        added only while the campaign is running; leads that arrive while it is paused are not added
        later.
      </p>
      {failure && (
        <div className="error-banner" role="alert">
          {failure}
        </div>
      )}
      {rules === null ? (
        !failure && <p className="empty-copy">Loading auto-enrol sources…</p>
      ) : active.length === 0 ? (
        <p className="empty-copy">No source adds leads to this campaign automatically.</p>
      ) : (
        <ul className="mgr-auto-enrol-rules">
          {active.map((rule) => (
            <li key={rule.id}>
              <span>
                <small>{SOURCE_LABEL[rule.sourceKind]}</small>
                <strong>{rule.sourceName ?? 'Removed source'}</strong>
              </span>
              {canManage && (
                <Button
                  variant="ghost"
                  disabled={busy !== ''}
                  aria-label={`Stop auto-enrolling from ${rule.sourceName ?? 'this source'}`}
                  onClick={() => void disable(rule)}
                >
                  {busy === rule.id ? 'Stopping…' : 'Stop'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canManage && !ended && rules !== null && (
        <details className="mgr-inputs">
          <summary>
            <strong>Add a source</strong>
            <span>Capture sources and other lead lists</span>
          </summary>
          <div className="mgr-inputs-body">
            {captureChoices.length + listChoices.length === 0 ? (
              <p className="empty-copy">Every available source already adds to this campaign.</p>
            ) : (
              <div className="li-filter-row mgr-auto-enrol-add">
                <Field label="Source">
                  <Select
                    value={choice}
                    disabled={busy !== ''}
                    onChange={(event) => setChoice(event.target.value)}
                  >
                    <option value="">Choose a source</option>
                    {captureChoices.length > 0 && (
                      <optgroup label="Capture sources">
                        {captureChoices.map((source) => (
                          <option key={source.id} value={`capture_source:${source.id}`}>
                            {source.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {listChoices.length > 0 && (
                      <optgroup label="Lead lists">
                        {listChoices.map((list) => (
                          <option key={list.id} value={`lead_list:${list.id}`}>
                            {list.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </Select>
                </Field>
                <Button
                  variant="primary"
                  disabled={busy !== '' || choice === ''}
                  onClick={() => void add()}
                >
                  {busy === 'add' ? 'Adding…' : 'Auto-enrol from this source'}
                </Button>
              </div>
            )}
          </div>
        </details>
      )}
    </section>
  );
}
