import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CrmContactUpsert } from './api';
import type { PlaybookRun } from '../shared/types';
import { crmUpsertApprovalRunId, CrmUpsertReview } from './CrmContactSync';

const base: CrmContactUpsert = {
  id: 'crmu_1',
  leadContactId: 'lead_1',
  provider: 'hubspot',
  connectionId: 'con_1',
  status: 'prepared',
  operation: 'update',
  matchTier: 'linkedin_url',
  crmRecordId: '301',
  plan: {
    identity: {},
    fields: { title: 'VP Sales' },
    conflicts: [{ field: 'firstName', crmValue: 'Janet', trevraValue: 'Jane' }],
    skipped: [{ field: 'email', reason: 'email_never_written' }],
    tiersSearched: [{ tier: 'linkedin_url', outcome: 'matched' }],
    candidates: [{ id: '301', label: 'Janet Doe' }]
  },
  payloadHash: 'a'.repeat(64),
  playbookRunId: 'pbr_1',
  resultRecordId: null,
  errorCode: null,
  preparedAt: '2026-10-31T09:00:00.000Z',
  executedAt: null
};

const render = (upsert: CrmContactUpsert) =>
  renderToStaticMarkup(<CrmUpsertReview upsert={upsert} provider="HubSpot" />);

describe('CRM sync review', () => {
  it('shows the match tier, the empty fields to fill, and what the CRM keeps', () => {
    const markup = render(base);
    expect(markup).toContain('Matched by LinkedIn URL');
    expect(markup).toContain('fills empty fields only');
    expect(markup).toContain('Empty field to fill');
    expect(markup).toContain('VP Sales');
    expect(markup).toContain('HubSpot keeps its own value');
    expect(markup).toContain('Janet');
    expect(markup).toContain('email is never added to an existing contact');
  });

  it('shows ambiguity as a block with the candidates and no planned write', () => {
    const markup = render({
      ...base,
      status: 'blocked_ambiguous',
      operation: null,
      matchTier: 'email',
      crmRecordId: null,
      payloadHash: null,
      playbookRunId: null,
      plan: {
        ...base.plan,
        fields: {},
        conflicts: [],
        skipped: [],
        candidates: [
          { id: '201', label: 'Jane Doe' },
          { id: '202', label: null }
        ]
      }
    });
    expect(markup).toContain('2 HubSpot contacts match on email. Nothing will be written.');
    expect(markup).toContain('record 201');
    expect(markup).toContain('Unnamed contact');
    expect(markup).not.toContain('Empty field to fill');
  });

  it('describes a create and links to approval only while the run waits', () => {
    const create = { ...base, operation: 'create' as const, matchTier: 'none' as const };
    expect(render(create)).toContain('No HubSpot contact matches');
    expect(render(create)).toContain('New contact field');

    const run = { id: 'pbr_1', status: 'waiting_approval' } as PlaybookRun;
    expect(crmUpsertApprovalRunId(base, run)).toBe('pbr_1');
    expect(crmUpsertApprovalRunId(base, { ...run, status: 'completed' })).toBeNull();
    expect(crmUpsertApprovalRunId({ ...base, status: 'blocked_ambiguous' }, null)).toBeNull();
  });
});
