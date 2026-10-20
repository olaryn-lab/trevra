import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nangoMock = vi.hoisted(() => ({
  post: vi.fn(async (_request: Record<string, unknown>) => ({
    data: { id: 'gmail-parity-provider-id', threadId: 'thread-parity' },
    headers: {}
  })),
  get: vi.fn(async (_request: Record<string, unknown>) => ({
    data: { payload: { headers: [{ name: 'Message-ID', value: '<gmail-parity@example.test>' }] } },
    headers: {}
  }))
}));
vi.mock('@nangohq/node', () => ({
  Nango: class {
    post = nangoMock.post;
    get = nangoMock.get;
  }
}));
import { openDatabase, type Db } from '../db.js';
import { findSuppression } from '../suppressions.js';
import { executeConnectedAction } from '../integration-service.js';
import {
  OUTREACH_OPT_OUT_SENTENCE,
  registerEmailComplianceProvider,
  resetEmailComplianceProvider
} from '../email/compliance.js';
import { createLeadList, importLeadCsv } from './lead-lists.js';
import {
  campaignMemberTimeline,
  campaignOperationalAnalytics,
  createManagedCampaign,
  listCampaignMembers,
  pauseManagedCampaign,
  startManagedCampaign,
  stopManagedCampaign
} from './managed-campaigns.js';
import {
  recordCampaignEmailEvent,
  recordCampaignEmailTrackingClick,
  recordCampaignEmailTrackingOpen,
  resolveCampaignChannelUnknownOutcome,
  runCampaignChannelActions,
  syncCampaignEmailProviderEvents
} from './campaign-channels.js';
import { runManagedCampaigns } from './runner.js';
import {
  approveCampaignEmail,
  campaignEmailPolicyGate,
  listCampaignEmailReviews,
  previewCampaignEmail
} from './campaign-email-approval.js';
import { upsertSeat } from './seats.js';
import { saveWorkflow } from './workflows.js';

let db: Db;
const WORKSPACE = 'ws_campaign_channels_test';
const NOW = new Date('2026-08-20T09:00:00.000Z');

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db
    .prepare(
      'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(WORKSPACE, 'Channel tests', NOW.toISOString());
  for (const table of [
    'gtm_deliveries',
    'linkedin_campaign_email_events',
    'linkedin_campaign_channel_actions',
    'linkedin_actions',
    'linkedin_campaign_members',
    'linkedin_campaign_waves',
    'linkedin_campaigns',
    'linkedin_workflows',
    'linkedin_lead_list_members',
    'linkedin_lead_contacts',
    'linkedin_lead_lists',
    'linkedin_seats'
  ]) {
    await db
      .prepare(`DELETE FROM ${table} WHERE workspace_id=?`)
      .run(WORKSPACE)
      .catch(() => undefined);
  }
  await db.prepare('DELETE FROM email_inbound_mailboxes WHERE workspace_id=?').run(WORKSPACE);
  await db.prepare('DELETE FROM email_deliverability_checks WHERE workspace_id=?').run(WORKSPACE);
  await db.prepare('DELETE FROM connections WHERE workspace_id=?').run(WORKSPACE);
  await db
    .prepare('DELETE FROM linkedin_campaign_email_approvals WHERE workspace_id=?')
    .run(WORKSPACE);
  await db.prepare('DELETE FROM workspace_policies WHERE workspace_id=?').run(WORKSPACE);
  await upsertSeat(
    db,
    WORKSPACE,
    { label: 'Owner', timezone: 'Europe/Zurich' },
    new Date('2026-01-01T09:00:00Z')
  );
});

afterEach(async () => {
  resetEmailComplianceProvider();
  vi.unstubAllEnvs();
  nangoMock.post.mockClear();
  nangoMock.get.mockClear();
  await db?.close();
});

async function seedReadyMailbox(): Promise<void> {
  vi.stubEnv('NANGO_API_KEY', 'local-test-nango-key');
  vi.stubEnv('TREVRA_PUBLIC_API_URL', 'https://api.trevra.test');
  vi.stubEnv('TREVRA_SECRETS_KEY', 'campaign-parity-test-secret-not-production');
  registerEmailComplianceProvider({
    footer: async () =>
      `Acme Labs, 1 Market Street\nPrivacy policy: https://acme.test/privacy\n${OUTREACH_OPT_OUT_SENTENCE}`,
    blockers: async () => []
  });
  await db
    .prepare(
      `INSERT INTO workspace_policies
      (id,workspace_id,name,priority,action_pattern,effect,conditions_json,enabled,created_at,updated_at)
      VALUES ('pol_channel_test_allow',?,'Allowed by fixture',10,'action:email.send','allow',
              '{}'::jsonb,TRUE,?::timestamptz,?::timestamptz)`
    )
    .run(WORKSPACE, NOW.toISOString(), NOW.toISOString());
  await db
    .prepare(
      `INSERT INTO connections
     (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,
      mailbox_address,created_at,updated_at)
     VALUES ('conn_campaign_live',?,'gmail','trevra-gmail','sender-live','Founder',
             'connected',0,'founder@acme.test',?::timestamptz,?::timestamptz)`
    )
    .run(WORKSPACE, NOW.toISOString(), NOW.toISOString());
  await db
    .prepare(
      `INSERT INTO email_inbound_mailboxes
     (workspace_id,connection_id,address,sync_status,designated_at,updated_at)
     VALUES (?,'conn_campaign_live','founder@acme.test','syncing',?::timestamptz,?::timestamptz)`
    )
    .run(WORKSPACE, NOW.toISOString(), NOW.toISOString());
  const pass = JSON.stringify({ status: 'pass', detail: 'valid', record: null });
  await db
    .prepare(
      `INSERT INTO email_deliverability_checks
     (workspace_id,domain,provider,status,spf_json,dkim_json,dmarc_json,blockers_json,warnings_json,
      checked_at,expires_at)
     VALUES (?,'acme.test','google','pass',?::jsonb,?::jsonb,?::jsonb,'[]'::jsonb,'[]'::jsonb,
             ?::timestamptz,'2099-01-01T00:00:00Z'::timestamptz)`
    )
    .run(WORKSPACE, pass, pass, pass, NOW.toISOString());
}

async function campaignFor(
  steps: Parameters<typeof saveWorkflow>[1]['steps'],
  csv: string,
  options: { enrichmentCreditCap?: number | null } = {}
) {
  const list = await createLeadList(db, { workspaceId: WORKSPACE, name: 'Leads' }, NOW);
  await importLeadCsv(db, { workspaceId: WORKSPACE, listId: list.id, csv }, NOW);
  const workflow = await saveWorkflow(
    db,
    { workspaceId: WORKSPACE, name: 'Channel flow', steps },
    NOW
  );
  const created = await createManagedCampaign(
    db,
    {
      workspaceId: WORKSPACE,
      name: 'Channel campaign',
      leadListId: list.id,
      workflowId: workflow.id,
      admissionPolicy: { maxWaveSize: 10 },
      enrichmentCreditCap: options.enrichmentCreditCap
    },
    NOW
  );
  await startManagedCampaign(db, WORKSPACE, created.campaign.id, NOW);
  return created.campaign.id;
}
async function queuedReviewEmail(actionId: string) {
  const campaignId = await campaignFor(
    [
      {
        id: 'wait',
        action: 'wait',
        delayBefore: { amount: 0, unit: 'hours' },
        config: { duration: { amount: 1, unit: 'days' } }
      },
      {
        id: 'end',
        action: 'end',
        delayBefore: { amount: 0, unit: 'hours' },
        config: { outcome: 'completed' }
      }
    ],
    `First Name,Last Name,Company,Email,LinkedIn URL\nMaya,Review,Acme,maya-review@example.com,https://linkedin.com/in/${actionId}\n`
  );
  await runManagedCampaigns(db, WORKSPACE, NOW);
  const member = (await listCampaignMembers(db, WORKSPACE, campaignId))[0]!;
  await db
    .prepare(
      "UPDATE linkedin_campaign_members SET status='waiting',current_step_id='review-email',step_index=0,next_eligible_at=?::timestamptz WHERE workspace_id=? AND id=?"
    )
    .run(NOW.toISOString(), WORKSPACE, member.id);
  await db
    .prepare(
      `INSERT INTO linkedin_campaign_channel_actions
     (id,workspace_id,campaign_id,member_id,contact_id,workflow_step_id,kind,status,planned_for,payload_json,
       idempotency_key,connection_id,created_at,updated_at)
     VALUES (?,?,?,?,?, 'review-email','email','planned',?::timestamptz,?::jsonb,?,
       'conn_campaign_live',?::timestamptz,?::timestamptz)`
    )
    .run(
      actionId,
      WORKSPACE,
      campaignId,
      member.id,
      member.contactId,
      NOW.toISOString(),
      JSON.stringify({
        recipient: 'maya-review@example.com',
        subject: 'Hello Maya',
        body: 'A specific reviewed body',
        tracking: 'off',
        threaded: false
      }),
      `idempotency-${actionId}`,
      NOW.toISOString(),
      NOW.toISOString()
    );
  return campaignId;
}

describe('campaign channel executor', () => {
  it('defaults to exact-message approval, holds safely, and sends only after the owner grants it', async () => {
    await seedReadyMailbox();
    await db.prepare('DELETE FROM workspace_policies WHERE workspace_id=?').run(WORKSPACE);
    const campaignId = await queuedReviewEmail('licha_review_default');
    const review = await previewCampaignEmail(db, WORKSPACE, 'licha_review_default');
    expect(review).toMatchObject({
      policy: { effect: 'require_approval' },
      approved: false,
      recipient: 'maya-review@example.com',
      sender: 'founder@acme.test',
      tracking: 'off'
    });
    expect(await listCampaignEmailReviews(db, WORKSPACE, campaignId)).toHaveLength(1);
    expect(await runCampaignChannelActions(db, WORKSPACE, NOW)).toMatchObject({
      claimed: 1,
      sent: 0,
      failed: 0,
      unknown: 0
    });
    expect(nangoMock.post).not.toHaveBeenCalled();
    expect((await campaignEmailPolicyGate(db, WORKSPACE, 'licha_review_default')).allowed).toBe(
      false
    );
    await expect(
      approveCampaignEmail(db, WORKSPACE, 'licha_review_default', 'wrong', 'owner', NOW)
    ).rejects.toThrow('changed since review');
    const approved = await approveCampaignEmail(
      db,
      WORKSPACE,
      'licha_review_default',
      review!.contentHash,
      'owner',
      NOW
    );
    expect(approved.approved).toBe(true);
    expect((await campaignEmailPolicyGate(db, WORKSPACE, 'licha_review_default')).allowed).toBe(
      true
    );
    const run = await runCampaignChannelActions(db, WORKSPACE, NOW);
    expect(run.sent).toBe(1);
    expect(nangoMock.post).toHaveBeenCalledTimes(1);
  });

  it('invalidates an exact approval when content, footer or sender changes', async () => {
    await seedReadyMailbox();
    await db.prepare('DELETE FROM workspace_policies WHERE workspace_id=?').run(WORKSPACE);
    await queuedReviewEmail('licha_review_mutated');
    const before = (await previewCampaignEmail(db, WORKSPACE, 'licha_review_mutated'))!;
    await approveCampaignEmail(db, WORKSPACE, before.actionId, before.contentHash, 'owner', NOW);
    await db
      .prepare(
        `UPDATE linkedin_campaign_channel_actions SET
       payload_json=jsonb_set(payload_json,'{body}',to_jsonb('A different body'::text))
       WHERE id=? AND workspace_id=?`
      )
      .run(before.actionId, WORKSPACE);
    const changed = (await previewCampaignEmail(db, WORKSPACE, before.actionId))!;
    expect(changed.approved).toBe(false);
    expect(changed.contentHash).not.toBe(before.contentHash);
    expect(await runCampaignChannelActions(db, WORKSPACE, NOW)).toMatchObject({
      claimed: 1,
      sent: 0,
      failed: 0,
      unknown: 0
    });
    expect(nangoMock.post).not.toHaveBeenCalled();
    await db
      .prepare(
        "UPDATE linkedin_campaign_channel_actions SET status='planned',planned_for=?::timestamptz WHERE id=?"
      )
      .run(NOW.toISOString(), before.actionId);
    await approveCampaignEmail(db, WORKSPACE, before.actionId, changed.contentHash, 'owner', NOW);
    await db
      .prepare(
        "UPDATE connections SET mailbox_address='new@acme.test' WHERE id='conn_campaign_live'"
      )
      .run();
    expect((await previewCampaignEmail(db, WORKSPACE, before.actionId))!.approved).toBe(false);
    expect((await campaignEmailPolicyGate(db, WORKSPACE, before.actionId)).allowed).toBe(false);
    await db
      .prepare(
        "UPDATE connections SET mailbox_address='founder@acme.test' WHERE id='conn_campaign_live'"
      )
      .run();
    expect((await previewCampaignEmail(db, WORKSPACE, before.actionId))!.approved).toBe(true);
    registerEmailComplianceProvider({
      footer: async () =>
        `Acme (new legal address), 2 Broadway\nPrivacy: https://acme.test/privacy\n${OUTREACH_OPT_OUT_SENTENCE}`,
      blockers: async () => []
    });
    expect((await previewCampaignEmail(db, WORKSPACE, before.actionId))!.approved).toBe(false);
    expect((await campaignEmailPolicyGate(db, WORKSPACE, before.actionId)).allowed).toBe(false);
    expect(nangoMock.post).not.toHaveBeenCalled();
  });

  it('denies workspace-policy forbidden email even if an approval is attempted', async () => {
    await seedReadyMailbox();
    await queuedReviewEmail('licha_review_denied');
    await db
      .prepare(
        "UPDATE workspace_policies SET effect='deny',name='Never send outbound email' WHERE workspace_id=?"
      )
      .run(WORKSPACE);
    const review = (await previewCampaignEmail(db, WORKSPACE, 'licha_review_denied'))!;
    expect(review.policy).toMatchObject({
      effect: 'deny',
      policyName: 'Never send outbound email'
    });
    await expect(
      approveCampaignEmail(db, WORKSPACE, review.actionId, review.contentHash, 'owner', NOW)
    ).rejects.toThrow('policy denies');
    expect(await runCampaignChannelActions(db, WORKSPACE, NOW)).toMatchObject({
      claimed: 1,
      sent: 0,
      failed: 0,
      unknown: 0
    });
    expect(nangoMock.post).not.toHaveBeenCalled();
  });

  it('rejects a forged provider body even when an exact action was reviewed', async () => {
    await seedReadyMailbox();
    await db.prepare('DELETE FROM workspace_policies WHERE workspace_id=?').run(WORKSPACE);
    await queuedReviewEmail('licha_review_forged');
    const review = (await previewCampaignEmail(db, WORKSPACE, 'licha_review_forged'))!;
    await approveCampaignEmail(db, WORKSPACE, review.actionId, review.contentHash, 'owner', NOW);
    const person = await db
      .prepare(
        `SELECT c.person_id,a.contact_id FROM linkedin_campaign_channel_actions a
        JOIN linkedin_lead_contacts c ON c.id=a.contact_id
        WHERE a.id='licha_review_forged' AND a.workspace_id=?`
      )
      .get<{ person_id: string; contact_id: string }>(WORKSPACE);
    await expect(
      executeConnectedAction(db, WORKSPACE, {
        type: 'email_draft',
        connection_id: 'conn_campaign_live',
        require_connection_id: true,
        recipient: review.recipient,
        subject: review.subject,
        body: 'FORGED CONTENT\n\n' + review.footer,
        payload_hash: 'forged-provider-envelope',
        structured_payload_json: JSON.stringify({
          deliverySourceType: 'campaign_email',
          deliverySourceId: review.actionId,
          approvalContentHash: review.contentHash,
          contactId: person!.contact_id,
          personId: person!.person_id,
          senderAddress: review.sender,
          tracking: review.tracking,
          threaded: review.threaded,
          deliveryPurpose: 'outreach',
          requireListUnsubscribe: true,
          unsubscribeMode: 'list_unsubscribe_headers'
        })
      })
    ).rejects.toThrow('no longer matches the exact approved preview');
    expect(nangoMock.post).not.toHaveBeenCalled();
  });

  it('does not expose another tenant’s pending email review', async () => {
    await seedReadyMailbox();
    const campaign = await queuedReviewEmail('licha_review_tenant');
    expect(await listCampaignEmailReviews(db, 'other_workspace', campaign)).toEqual([]);
    expect(await previewCampaignEmail(db, 'other_workspace', 'licha_review_tenant')).toBeNull();
    await expect(
      approveCampaignEmail(
        db,
        'other_workspace',
        'licha_review_tenant',
        '0'.repeat(64),
        'other-owner',
        NOW
      )
    ).rejects.toThrow('not awaiting approval');
  });
  it('does not claim channel work while a campaign is paused and retires it on stop', async () => {
    const campaignId = await campaignFor(
      [
        {
          id: 'end',
          action: 'end',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { outcome: 'completed' }
        }
      ],
      'First Name,Last Name,Company,Email,LinkedIn URL\nMaya,Smith,Acme,maya@example.com,https://linkedin.com/in/maya-paused-channel\n'
    );
    const member = (await listCampaignMembers(db, WORKSPACE, campaignId))[0]!;
    await db
      .prepare(
        `UPDATE linkedin_campaign_members SET status='waiting',admitted_at=?::timestamptz
         WHERE workspace_id=? AND id=?`
      )
      .run(NOW.toISOString(), WORKSPACE, member.id);
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_channel_actions
          (id,workspace_id,campaign_id,member_id,contact_id,workflow_step_id,kind,status,planned_for,payload_json,idempotency_key,outcome_known,created_at,updated_at)
         VALUES ('licha_pause',?,?,?,?,?,'email','planned',?::timestamptz,'{}'::jsonb,'pause-key',TRUE,?::timestamptz,?::timestamptz)`
      )
      .run(
        WORKSPACE,
        campaignId,
        member.id,
        member.contactId,
        'email-fixture',
        NOW.toISOString(),
        NOW.toISOString(),
        NOW.toISOString()
      );

    await pauseManagedCampaign(db, WORKSPACE, campaignId, NOW);
    expect((await runCampaignChannelActions(db, WORKSPACE, NOW)).claimed).toBe(0);
    expect(
      await db
        .prepare(
          `SELECT status FROM linkedin_campaign_channel_actions WHERE workspace_id=? AND id='licha_pause'`
        )
        .get<{ status: string }>(WORKSPACE)
    ).toEqual({ status: 'planned' });

    await stopManagedCampaign(db, WORKSPACE, campaignId, new Date(NOW.getTime() + 60_000));
    expect(
      await db
        .prepare(
          `SELECT status FROM linkedin_campaign_channel_actions WHERE workspace_id=? AND id='licha_pause'`
        )
        .get<{ status: string }>(WORKSPACE)
    ).toEqual({ status: 'skipped' });
  });

  it('uses an existing email without enrichment cost and advances the member exactly once', async () => {
    const campaignId = await campaignFor(
      [
        {
          id: 'find',
          action: 'find_email',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { providerId: null, refresh: false }
        },
        {
          id: 'end',
          action: 'end',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { outcome: 'completed' }
        }
      ],
      'First Name,Last Name,Company,Email,LinkedIn URL\nMaya,Smith,Acme,maya@example.com,https://linkedin.com/in/maya-smith\n'
    );

    await runManagedCampaigns(db, WORKSPACE, NOW);
    const action = await db
      .prepare(
        `SELECT status,external_ref FROM linkedin_campaign_channel_actions WHERE workspace_id=? AND campaign_id=? AND workflow_step_id='find'`
      )
      .get<{ status: string; external_ref: string | null }>(WORKSPACE, campaignId);
    expect(action).toMatchObject({ status: 'sent', external_ref: 'email:maya@example.com' });
    const member = (await listCampaignMembers(db, WORKSPACE, campaignId))[0]!;
    expect(member.stepIndex).toBe(1);
    expect(member.branchState['external:email_found']).toBe(true);
    const timeline = await campaignMemberTimeline(db, WORKSPACE, member.id);
    expect(timeline?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'channel',
          label: 'find email',
          stepId: 'find',
          stepLabel: 'find email',
          status: 'sent'
        })
      ])
    );

    await runManagedCampaigns(db, WORKSPACE, new Date(NOW.getTime() + 60_000));
    expect((await listCampaignMembers(db, WORKSPACE, campaignId))[0]?.status).toBe('completed');
    const count = await db
      .prepare(
        `SELECT COUNT(*)::int AS total FROM linkedin_campaign_channel_actions WHERE workspace_id=? AND campaign_id=?`
      )
      .get<{ total: number }>(WORKSPACE, campaignId);
    expect(count?.total).toBe(1);
  });

  it('resolves an unknown channel outcome without replaying the side effect', async () => {
    const campaignId = await campaignFor(
      [
        {
          id: 'find',
          action: 'find_email',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { providerId: null, refresh: false }
        },
        {
          id: 'end',
          action: 'end',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { outcome: 'completed' }
        }
      ],
      'First Name,Last Name,Company,Email,LinkedIn URL\nMaya,Smith,Acme,maya@example.com,https://linkedin.com/in/maya-unknown-channel\n'
    );
    await runManagedCampaigns(db, WORKSPACE, NOW);
    const member = (await listCampaignMembers(db, WORKSPACE, campaignId))[0]!;
    const channel = await db
      .prepare(
        `SELECT id FROM linkedin_campaign_channel_actions
         WHERE workspace_id=? AND campaign_id=? AND workflow_step_id='find'`
      )
      .get<{ id: string }>(WORKSPACE, campaignId);
    expect(channel).toBeDefined();

    // Recreate the crash boundary: provider may have acted, but Trevra did not learn the outcome.
    await db
      .prepare(
        `UPDATE linkedin_campaign_channel_actions
         SET status='unknown',outcome_known=FALSE,external_ref=NULL,provider=NULL,last_error='socket closed'
         WHERE workspace_id=? AND id=?`
      )
      .run(WORKSPACE, channel!.id);
    await db
      .prepare(
        `UPDATE linkedin_campaign_members
         SET step_index=0,current_step_id='find',completed_step_ids='[]'::jsonb,status='waiting',next_eligible_at=?::timestamptz
         WHERE workspace_id=? AND id=?`
      )
      .run(NOW.toISOString(), WORKSPACE, member.id);

    const resolved = await resolveCampaignChannelUnknownOutcome(
      db,
      WORKSPACE,
      channel!.id,
      'sent',
      new Date(NOW.getTime() + 60_000)
    );
    expect(resolved.resolved).toBe(true);
    const settled = await db
      .prepare(
        `SELECT status,outcome_known,external_ref FROM linkedin_campaign_channel_actions WHERE workspace_id=? AND id=?`
      )
      .get<{ status: string; outcome_known: boolean; external_ref: string | null }>(
        WORKSPACE,
        channel!.id
      );
    expect(settled).toMatchObject({
      status: 'sent',
      outcome_known: true,
      external_ref: 'operator-confirmed'
    });
    const after = (await listCampaignMembers(db, WORKSPACE, campaignId))[0]!;
    expect(after.stepIndex).toBe(1);
  });

  it('reserves enrichment credits exactly once and blocks before the provider when the campaign cap is exhausted', async () => {
    let hits = 0;
    let server: Server | null = null;
    const port = await new Promise<number>((resolve) => {
      server = createServer((req, res) => {
        hits += 1;
        req.resume();
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            email: `found${hits}@example.com`,
            confidence: 0.91,
            verificationStatus: 'verified'
          })
        );
      }).listen(0, '127.0.0.1', () => {
        const address = server!.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
    const previousUrl = process.env.TREVRA_EMAIL_ENRICHMENT_URL;
    process.env.TREVRA_EMAIL_ENRICHMENT_URL = `http://127.0.0.1:${port}/enrich`;
    try {
      const campaignId = await campaignFor(
        [
          {
            id: 'find',
            action: 'find_email',
            delayBefore: { amount: 0, unit: 'hours' },
            config: { providerId: 'test', refresh: false }
          },
          {
            id: 'end',
            action: 'end',
            delayBefore: { amount: 0, unit: 'hours' },
            config: { outcome: 'completed' }
          }
        ],
        'First Name,Last Name,Company,LinkedIn URL\nMaya,One,Acme,https://linkedin.com/in/maya-one\nJon,Two,Acme,https://linkedin.com/in/jon-two\n',
        { enrichmentCreditCap: 1 }
      );
      await runManagedCampaigns(db, WORKSPACE, NOW);
      expect(hits).toBe(1);
      const run = await runCampaignChannelActions(db, WORKSPACE, NOW);
      expect(run.sent).toBe(0);
      expect(run.failed).toBe(0);
      const rows = await db
        .prepare(
          `SELECT status,credits_used,last_error FROM linkedin_campaign_channel_actions WHERE workspace_id=? AND campaign_id=? AND kind='find_email' ORDER BY id`
        )
        .all<{ status: string; credits_used: number; last_error: string | null }>(
          WORKSPACE,
          campaignId
        );
      expect(rows.map((row) => Number(row.credits_used)).sort()).toEqual([0, 1]);
      expect(
        rows.some(
          (row) => row.status === 'failed' && /credit cap reached/i.test(row.last_error ?? '')
        )
      ).toBe(true);
      const enriched = await db
        .prepare(
          `SELECT email,email_provenance,email_confidence,email_verification_status FROM linkedin_lead_contacts WHERE workspace_id=? AND email IS NOT NULL`
        )
        .all<{
          email: string;
          email_provenance: string | null;
          email_confidence: number | null;
          email_verification_status: string | null;
        }>(WORKSPACE);
      expect(enriched).toHaveLength(1);
      expect(enriched[0].email_provenance).toBe('enriched');
      expect(Number(enriched[0].email_confidence)).toBeCloseTo(0.91);
      expect(enriched[0].email_verification_status).toBe('verified');
      await runCampaignChannelActions(db, WORKSPACE, new Date(NOW.getTime() + 60_000));
      expect(hits).toBe(1);
    } finally {
      if (previousUrl === undefined) delete process.env.TREVRA_EMAIL_ENRICHMENT_URL;
      else process.env.TREVRA_EMAIL_ENRICHMENT_URL = previousUrl;
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
  });

  it('turns a provider-observed email bounce into a durable email suppression', async () => {
    const campaignId = await campaignFor(
      [
        {
          id: 'email',
          action: 'email',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { variants: [{ id: 'a', body: 'Hi', weight: 100 }], subject: 'Hello' }
        }
      ],
      'First Name,Last Name,Company,Email,LinkedIn URL\nMaya,Smith,Acme,bounce-me@example.com,https://linkedin.com/in/maya-bounce\n'
    );
    const member = (await listCampaignMembers(db, WORKSPACE, campaignId))[0]!;
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_channel_actions
          (id,workspace_id,campaign_id,member_id,contact_id,workflow_step_id,kind,status,planned_for,payload_json,idempotency_key,completed_at,external_ref,provider,created_at,updated_at)
         VALUES ('licha_bounce',?,?,?,?,?,'email','sent',?::timestamptz,'{}'::jsonb,'idem-bounce',?::timestamptz,'mail-bounce','simulation',?::timestamptz,?::timestamptz)`
      )
      .run(
        WORKSPACE,
        campaignId,
        member.id,
        member.contactId,
        'email',
        NOW.toISOString(),
        NOW.toISOString(),
        NOW.toISOString(),
        NOW.toISOString()
      );

    const event = await recordCampaignEmailEvent(
      db,
      WORKSPACE,
      {
        channelActionId: 'licha_bounce',
        eventKind: 'bounce',
        providerEventId: 'provider-bounce-1'
      },
      NOW
    );
    expect(event.recorded).toBe(true);
    expect(
      await findSuppression(db, WORKSPACE, { channel: 'email', email: 'bounce-me@example.com' })
    ).toMatchObject({ reason: 'Email delivery hard-bounced', source: 'campaign_email_bounce' });
  });

  it('an email reply stops LinkedIn and channel work for the same member', async () => {
    const campaignId = await campaignFor(
      [
        {
          id: 'wait',
          action: 'wait',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { duration: { amount: 1, unit: 'days' } }
        },
        {
          id: 'end',
          action: 'end',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { outcome: 'completed' }
        }
      ],
      'First Name,Last Name,Company,Email,LinkedIn URL\nMaya,Smith,Acme,maya@example.com,https://linkedin.com/in/maya-smith\n'
    );
    await runManagedCampaigns(db, WORKSPACE, NOW);
    const member = (await listCampaignMembers(db, WORKSPACE, campaignId))[0]!;
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_channel_actions (id,workspace_id,campaign_id,member_id,contact_id,workflow_step_id,kind,status,planned_for,payload_json,idempotency_key,completed_at,external_ref,provider,created_at,updated_at)
       VALUES ('licha_email',?,?,?,?,?,'email','sent',?::timestamptz,'{}'::jsonb,'idem-email',?::timestamptz,'mail-ref','simulation',?::timestamptz,?::timestamptz)`
      )
      .run(
        WORKSPACE,
        campaignId,
        member.id,
        member.contactId,
        'email-step',
        NOW.toISOString(),
        NOW.toISOString(),
        NOW.toISOString(),
        NOW.toISOString()
      );
    await db
      .prepare(
        `INSERT INTO linkedin_actions (id,workspace_id,seat_key,kind,target_ref,status,planned_for,campaign_id,campaign_member_id,source,replay_scope,created_at)
       VALUES ('lact_future',?,'owner','dm','https://linkedin.com/in/maya-smith','planned',?::timestamptz,?,?, 'campaign','future',?::timestamptz)`
      )
      .run(
        WORKSPACE,
        new Date(NOW.getTime() + 3600000).toISOString(),
        campaignId,
        member.id,
        NOW.toISOString()
      );
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_channel_actions (id,workspace_id,campaign_id,member_id,contact_id,workflow_step_id,kind,status,planned_for,payload_json,idempotency_key,created_at,updated_at)
       VALUES ('licha_future',?,?,?,?,?,'email','planned',?::timestamptz,'{}'::jsonb,'idem-future',?::timestamptz,?::timestamptz)`
      )
      .run(
        WORKSPACE,
        campaignId,
        member.id,
        member.contactId,
        'hook-next',
        new Date(NOW.getTime() + 3600000).toISOString(),
        NOW.toISOString(),
        NOW.toISOString()
      );

    const event = await recordCampaignEmailEvent(
      db,
      WORKSPACE,
      { channelActionId: 'licha_email', eventKind: 'reply', providerEventId: 'evt-reply' },
      NOW
    );
    expect(event.recorded).toBe(true);
    expect((await listCampaignMembers(db, WORKSPACE, campaignId))[0]?.status).toBe('replied');
    expect(
      (
        await db
          .prepare(`SELECT status FROM linkedin_actions WHERE id='lact_future'`)
          .get<{ status: string }>()
      )?.status
    ).toBe('skipped');
    expect(
      (
        await db
          .prepare(`SELECT status FROM linkedin_campaign_channel_actions WHERE id='licha_future'`)
          .get<{ status: string }>()
      )?.status
    ).toBe('skipped');
  });

  it('reconciles actual email events with funnel, channel counters and branch keys', async () => {
    const campaignId = await campaignFor(
      [
        {
          id: 'wait',
          action: 'wait',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { duration: { amount: 1, unit: 'days' } }
        },
        {
          id: 'end',
          action: 'end',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { outcome: 'completed' }
        }
      ],
      'First Name,Last Name,Company,Email,LinkedIn URL\nMaya,Smith,Acme,parity-reply@example.com,https://linkedin.com/in/parity-reply\n'
    );
    await runManagedCampaigns(db, WORKSPACE, NOW);
    const member = (await listCampaignMembers(db, WORKSPACE, campaignId))[0]!;
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_channel_actions
         (id,workspace_id,campaign_id,member_id,contact_id,workflow_step_id,kind,status,planned_for,payload_json,idempotency_key,completed_at,external_ref,provider,created_at,updated_at)
       VALUES ('licha_parity',?,?,?,?,?,'email','sent',?::timestamptz,'{}'::jsonb,'idem-parity',?::timestamptz,'parity-ref','simulation',?::timestamptz,?::timestamptz)`
      )
      .run(
        WORKSPACE,
        campaignId,
        member.id,
        member.contactId,
        'wait',
        NOW.toISOString(),
        NOW.toISOString(),
        NOW.toISOString(),
        NOW.toISOString()
      );
    const before = await campaignOperationalAnalytics(db, WORKSPACE, campaignId, NOW);
    expect(before.funnel.messaged).toBe(1);
    expect(before.funnel.replied).toBe(0);
    for (const kind of ['opened', 'clicked', 'reply'] as const) {
      await recordCampaignEmailEvent(
        db,
        WORKSPACE,
        { channelActionId: 'licha_parity', eventKind: kind, providerEventId: `evt-parity-${kind}` },
        NOW
      );
    }
    const after = await campaignOperationalAnalytics(db, WORKSPACE, campaignId, NOW);
    expect(after.funnel.messaged).toBe(1);
    expect(after.funnel.replied).toBe(1);
    expect(after.channels.emailSent).toBe(1);
    expect(after.channels.emailReplied).toBe(1);
    const refreshed = (await listCampaignMembers(db, WORKSPACE, campaignId))[0]!;
    expect(refreshed.branchState).toMatchObject({
      'external:email_opened': true,
      'external:email_clicked': true,
      'external:email_reply': true,
      'external:email_replied': true
    });
  });

  it('records an email unsubscribe as excluded, not as a positive reply', async () => {
    const campaignId = await campaignFor(
      [
        {
          id: 'wait',
          action: 'wait',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { duration: { amount: 1, unit: 'days' } }
        },
        {
          id: 'end',
          action: 'end',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { outcome: 'completed' }
        }
      ],
      'First Name,Last Name,Company,Email,LinkedIn URL\nPat,Lee,Acme,parity-optout@example.com,https://linkedin.com/in/parity-optout\n'
    );
    await runManagedCampaigns(db, WORKSPACE, NOW);
    const member = (await listCampaignMembers(db, WORKSPACE, campaignId))[0]!;
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_channel_actions
         (id,workspace_id,campaign_id,member_id,contact_id,workflow_step_id,kind,status,planned_for,payload_json,idempotency_key,completed_at,external_ref,provider,created_at,updated_at)
       VALUES ('licha_optout',?,?,?,?,?,'email','sent',?::timestamptz,'{}'::jsonb,'idem-optout',?::timestamptz,'optout-ref','simulation',?::timestamptz,?::timestamptz)`
      )
      .run(
        WORKSPACE,
        campaignId,
        member.id,
        member.contactId,
        'wait',
        NOW.toISOString(),
        NOW.toISOString(),
        NOW.toISOString(),
        NOW.toISOString()
      );
    await recordCampaignEmailEvent(
      db,
      WORKSPACE,
      { channelActionId: 'licha_optout', eventKind: 'unsubscribe', providerEventId: 'evt-optout' },
      NOW
    );
    const analytics = await campaignOperationalAnalytics(db, WORKSPACE, campaignId, NOW);
    expect(analytics.funnel.excluded).toBe(1);
    expect(analytics.funnel.replied).toBe(0);
    expect(analytics.channels.emailReplied).toBe(0);
    expect((await listCampaignMembers(db, WORKSPACE, campaignId))[0]?.status).toBe('excluded');
    expect(
      await findSuppression(db, WORKSPACE, { channel: 'email', email: 'parity-optout@example.com' })
    ).not.toBeNull();
  });

  it('never claims a channel action that is no longer the member current workflow node', async () => {
    const campaignId = await campaignFor(
      [
        {
          id: 'wait',
          action: 'wait',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { duration: { amount: 1, unit: 'days' } }
        },
        {
          id: 'end',
          action: 'end',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { outcome: 'completed' }
        }
      ],
      'First Name,Last Name,Company,Email,LinkedIn URL\nMaya,Smith,Acme,maya@example.com,https://linkedin.com/in/maya-stale-channel\n'
    );
    await runManagedCampaigns(db, WORKSPACE, NOW);
    const member = (await listCampaignMembers(db, WORKSPACE, campaignId))[0]!;
    await db
      .prepare(
        `UPDATE linkedin_campaign_members SET status='waiting',current_step_id='end',step_index=1,next_eligible_at=?::timestamptz
         WHERE workspace_id=? AND id=?`
      )
      .run(NOW.toISOString(), WORKSPACE, member.id);
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_channel_actions
         (id,workspace_id,campaign_id,member_id,contact_id,workflow_step_id,kind,status,planned_for,payload_json,idempotency_key,created_at,updated_at)
         VALUES ('licha_stale',?,?,?,?,?,'email','planned',?::timestamptz,?::jsonb,'stale-key',?::timestamptz,?::timestamptz)`
      )
      .run(
        WORKSPACE,
        campaignId,
        member.id,
        member.contactId,
        'old-email-step',
        NOW.toISOString(),
        JSON.stringify({ recipient: 'maya@example.com', subject: 'Old', body: 'Do not send' }),
        NOW.toISOString(),
        NOW.toISOString()
      );

    expect((await runCampaignChannelActions(db, WORKSPACE, NOW)).claimed).toBe(0);
    expect(
      await db
        .prepare(`SELECT status FROM linkedin_campaign_channel_actions WHERE id='licha_stale'`)
        .get<{ status: string }>()
    ).toEqual({ status: 'planned' });
  });

  it('sends a compliant campaign email only from its verified mailbox and stamps RFC8058 headers', async () => {
    const campaignId = await campaignFor(
      [
        {
          id: 'wait',
          action: 'wait',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { duration: { amount: 1, unit: 'days' } }
        },
        {
          id: 'end',
          action: 'end',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { outcome: 'completed' }
        }
      ],
      'First Name,Last Name,Company,Email,LinkedIn URL\nMaya,Smith,Acme,maya@example.com,https://linkedin.com/in/maya-track-send\n'
    );
    await runManagedCampaigns(db, WORKSPACE, NOW);
    const member = (await listCampaignMembers(db, WORKSPACE, campaignId))[0]!;
    await seedReadyMailbox();
    await db
      .prepare(
        `UPDATE linkedin_campaign_members SET status='waiting',current_step_id='email-live',step_index=0,next_eligible_at=?::timestamptz
         WHERE workspace_id=? AND id=?`
      )
      .run(NOW.toISOString(), WORKSPACE, member.id);
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_channel_actions
         (id,workspace_id,campaign_id,member_id,contact_id,workflow_step_id,kind,status,planned_for,payload_json,idempotency_key,created_at,updated_at)
         VALUES ('licha_track_send',?,?,?,?,?,'email','planned',?::timestamptz,?::jsonb,'track-send-key',?::timestamptz,?::timestamptz)`
      )
      .run(
        WORKSPACE,
        campaignId,
        member.id,
        member.contactId,
        'email-live',
        NOW.toISOString(),
        JSON.stringify({
          recipient: 'maya@example.com',
          subject: 'Tracked email',
          body: 'See https://example.com/demo for details',
          tracking: 'opens_clicks',
          threaded: false
        }),
        NOW.toISOString(),
        NOW.toISOString()
      );

    await db
      .prepare(
        "UPDATE linkedin_campaign_channel_actions SET connection_id='conn_campaign_live' WHERE id='licha_track_send'"
      )
      .run();
    await db
      .prepare(
        "UPDATE linkedin_campaign_channel_actions SET connection_id='conn_campaign_live' WHERE id='licha_track_send'"
      )
      .run();
    const run = await runCampaignChannelActions(db, WORKSPACE, NOW);
    expect(run.sent).toBe(1);
    const action = await db
      .prepare(
        `SELECT status,tracking_token,connection_id FROM linkedin_campaign_channel_actions WHERE id='licha_track_send'`
      )
      .get<{ status: string; tracking_token: string | null; connection_id: string | null }>();
    expect(action?.status).toBe('sent');
    expect(action?.tracking_token).toMatch(/^lietrk_/);
    expect(action?.connection_id).toBe('conn_campaign_live');
    expect(nangoMock.post).toHaveBeenCalledTimes(1);
    const request = nangoMock.post.mock.calls[0]![0] as Record<string, any>;
    expect(request.connectionId).toBe('sender-live');
    const mime = Buffer.from(String(request.data.raw), 'base64url').toString('utf8');
    expect(mime).toContain('List-Unsubscribe:');
    expect(mime).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
    expect(mime).toContain('Privacy policy:');
    expect(mime).toContain(OUTREACH_OPT_OUT_SENTENCE);
    const footerLinks = await db
      .prepare(
        "SELECT target_url FROM linkedin_campaign_email_tracking_links WHERE workspace_id=? AND channel_action_id='licha_track_send'"
      )
      .all<{ target_url: string }>(WORKSPACE);
    expect(footerLinks.map((entry) => entry.target_url)).not.toContain('https://acme.test/privacy');
    expect(mime).toContain('https://acme.test/privacy');
    const link = await db
      .prepare(
        `SELECT token,target_url FROM linkedin_campaign_email_tracking_links WHERE workspace_id=? AND channel_action_id='licha_track_send'`
      )
      .get<{ token: string; target_url: string }>(WORKSPACE);
    expect(link?.token).toMatch(/^lietl_/);
    expect(link?.target_url).toBe('https://example.com/demo');
  });

  it('rechecks do-not-contact at the shared provider boundary after the campaign preflight', async () => {
    await seedReadyMailbox();
    const campaignId = await campaignFor(
      [
        {
          id: 'wait',
          action: 'wait',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { duration: { amount: 1, unit: 'days' } }
        },
        {
          id: 'end',
          action: 'end',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { outcome: 'completed' }
        }
      ],
      'First Name,Last Name,Company,Email,LinkedIn URL\nMaya,Smith,Acme,maya@example.com,https://linkedin.com/in/provider-race\n'
    );
    const member = (await listCampaignMembers(db, WORKSPACE, campaignId))[0]!;
    const contact = await db
      .prepare('SELECT person_id FROM linkedin_lead_contacts WHERE workspace_id=? AND id=?')
      .get<{ person_id: string | null }>(WORKSPACE, member.contactId);
    expect(contact?.person_id).toBeTruthy();
    // Reproduce a stale claim: the campaign earlier approved a Person, who opted out
    // before the shared Gmail/Microsoft execution boundary.
    await db
      .prepare(
        'UPDATE linkedin_lead_contacts SET do_not_contact=TRUE WHERE workspace_id=? AND id=?'
      )
      .run(WORKSPACE, member.contactId);
    await expect(
      executeConnectedAction(db, WORKSPACE, {
        type: 'email_draft',
        connection_id: 'conn_campaign_live',
        require_connection_id: true,
        recipient: 'maya@example.com',
        subject: 'Hello',
        body: 'Hi Maya',
        payload_hash: 'provider-race-no-send',
        structured_payload_json: JSON.stringify({
          deliverySourceType: 'campaign_email',
          deliverySourceId: 'licha_race',
          deliveryPurpose: 'outreach',
          requireListUnsubscribe: true,
          unsubscribeMode: 'list_unsubscribe_headers',
          senderAddress: 'founder@acme.test',
          personId: contact!.person_id,
          contactId: member.contactId
        })
      })
    ).rejects.toThrow('recipient identity or reachability changed');
    expect(nangoMock.post).not.toHaveBeenCalled();
    expect(
      await db
        .prepare('SELECT COUNT(*)::int AS total FROM gtm_deliveries WHERE workspace_id=?')
        .get<{ total: number }>(WORKSPACE)
    ).toEqual({ total: 0 });
  });

  it('defers a campaign email without a verified mailbox; no provider call, tracking or failure attribution', async () => {
    const campaignId = await campaignFor(
      [
        {
          id: 'wait',
          action: 'wait',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { duration: { amount: 1, unit: 'days' } }
        },
        {
          id: 'end',
          action: 'end',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { outcome: 'completed' }
        }
      ],
      'First Name,Last Name,Company,Email,LinkedIn URL\nMaya,Smith,Acme,maya@example.com,https://linkedin.com/in/maya-unready\n'
    );
    await runManagedCampaigns(db, WORKSPACE, NOW);
    const member = (await listCampaignMembers(db, WORKSPACE, campaignId))[0]!;
    await seedReadyMailbox(); // Never choose this valid live mailbox without campaign assignment.
    await db
      .prepare(
        `UPDATE linkedin_campaign_members SET status='waiting',current_step_id='email-step',
       step_index=0,next_eligible_at=?::timestamptz WHERE workspace_id=? AND id=?`
      )
      .run(NOW.toISOString(), WORKSPACE, member.id);
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_channel_actions
       (id,workspace_id,campaign_id,member_id,contact_id,workflow_step_id,kind,status,planned_for,payload_json,idempotency_key,created_at,updated_at)
       VALUES ('licha_unready',?,?,?,?,?,'email','planned',?::timestamptz,?::jsonb,'unready-key',?::timestamptz,?::timestamptz)`
      )
      .run(
        WORKSPACE,
        campaignId,
        member.id,
        member.contactId,
        'email-step',
        NOW.toISOString(),
        JSON.stringify({
          recipient: 'maya@example.com',
          subject: 'Hello',
          body: 'https://example.com',
          tracking: 'opens_clicks'
        }),
        NOW.toISOString(),
        NOW.toISOString()
      );
    const run = await runCampaignChannelActions(db, WORKSPACE, NOW);
    expect(run).toMatchObject({ claimed: 1, sent: 0, failed: 0, unknown: 0 });
    const deferred = await db
      .prepare(
        "SELECT status,last_error,tracking_token FROM linkedin_campaign_channel_actions WHERE id='licha_unready'"
      )
      .get<{ status: string; last_error: string | null; tracking_token: string | null }>();
    expect(deferred).toMatchObject({ status: 'planned', tracking_token: null });
    expect(deferred?.last_error).toContain('sending mailbox');
    expect(nangoMock.post).not.toHaveBeenCalled();
    expect((await listCampaignMembers(db, WORKSPACE, campaignId))[0]?.currentStepId).toBe(
      'email-step'
    );
    expect((await runCampaignChannelActions(db, WORKSPACE, NOW)).claimed).toBe(0);
  });

  it.each([
    ['no inbound reply sync', 'Replies are not syncing'],
    ['DNS failed', 'Sender SPF, DKIM and DMARC must all pass'],
    ['missing legal footer', 'compliance footer are required'],
    ['no unsubscribe origin', 'one-click unsubscribe']
  ])('defers pre-send for %s without external effects', async (scenario, detail) => {
    await seedReadyMailbox();
    if (scenario === 'no inbound reply sync')
      await db
        .prepare(
          "UPDATE email_inbound_mailboxes SET sync_status='unavailable' WHERE workspace_id=?"
        )
        .run(WORKSPACE);
    if (scenario === 'DNS failed')
      await db
        .prepare("UPDATE email_deliverability_checks SET status='fail' WHERE workspace_id=?")
        .run(WORKSPACE);
    if (scenario === 'missing legal footer') resetEmailComplianceProvider();
    if (scenario === 'no unsubscribe origin') vi.stubEnv('TREVRA_SECRETS_KEY', '');
    const campaignId = await campaignFor(
      [
        {
          id: 'wait',
          action: 'wait',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { duration: { amount: 1, unit: 'days' } }
        },
        {
          id: 'end',
          action: 'end',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { outcome: 'completed' }
        }
      ],
      'First Name,Last Name,Company,Email,LinkedIn URL\nMaya,Smith,Acme,maya@example.com,https://linkedin.com/in/maya-config-' +
        scenario.replaceAll(' ', '-') +
        '\n'
    );
    await runManagedCampaigns(db, WORKSPACE, NOW);
    const member = (await listCampaignMembers(db, WORKSPACE, campaignId))[0]!;
    await db
      .prepare(
        "UPDATE linkedin_campaign_members SET status='waiting',current_step_id='email-live',step_index=0 WHERE workspace_id=? AND id=?"
      )
      .run(WORKSPACE, member.id);
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_channel_actions
      (id,workspace_id,campaign_id,member_id,contact_id,workflow_step_id,kind,status,planned_for,payload_json,idempotency_key,created_at,updated_at)
      VALUES ('licha_config',?,?,?,?,?,'email','planned',?::timestamptz,?::jsonb,'config-key',?::timestamptz,?::timestamptz)`
      )
      .run(
        WORKSPACE,
        campaignId,
        member.id,
        member.contactId,
        'email-live',
        NOW.toISOString(),
        JSON.stringify({
          recipient: 'maya@example.com',
          subject: 'Hey',
          body: 'Hi Maya',
          tracking: 'opens_clicks'
        }),
        NOW.toISOString(),
        NOW.toISOString()
      );
    await db
      .prepare(
        "UPDATE linkedin_campaign_channel_actions SET connection_id='conn_campaign_live' WHERE id='licha_config'"
      )
      .run();
    const run = await runCampaignChannelActions(db, WORKSPACE, NOW);
    expect(run).toMatchObject({ claimed: 1, sent: 0, failed: 0, unknown: 0 });
    const state = await db
      .prepare(
        "SELECT status,last_error,tracking_token FROM linkedin_campaign_channel_actions WHERE id='licha_config'"
      )
      .get<{ status: string; last_error: string | null; tracking_token: string | null }>();
    expect(state).toMatchObject({ status: 'planned', tracking_token: null });
    expect(state?.last_error).toContain(detail);
    expect(nangoMock.post).not.toHaveBeenCalled();
  });

  it('refuses campaign cold email with no recorded lawful basis before any tracking exists', async () => {
    const campaignId = await campaignFor(
      [
        {
          id: 'email-live',
          action: 'email',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { variants: [{ id: 'a', body: 'Hi', weight: 100 }], subject: 'Hello' }
        },
        {
          id: 'end',
          action: 'end',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { outcome: 'completed' }
        }
      ],
      'First Name,Last Name,Company,Email,LinkedIn URL,Country\nMaya,Huber,Acme GmbH,maya@acme-gmbh.de,https://linkedin.com/in/maya-lawful-basis,Germany\n'
    );
    await runManagedCampaigns(db, WORKSPACE, NOW);
    const member = (await listCampaignMembers(db, WORKSPACE, campaignId))[0]!;
    await db
      .prepare(
        `INSERT INTO connections
           (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,created_at,updated_at)
           VALUES ('conn_demo_basis',?,'gmail','trevra-gmail','demo-basis','demo@example.com','connected',1,?::timestamptz,?::timestamptz)
           ON CONFLICT (id) DO NOTHING`
      )
      .run(WORKSPACE, NOW.toISOString(), NOW.toISOString());
    await db
      .prepare(
        `UPDATE linkedin_campaign_members SET status='waiting',current_step_id='email-live',step_index=0,next_eligible_at=?::timestamptz
           WHERE workspace_id=? AND id=?`
      )
      .run(NOW.toISOString(), WORKSPACE, member.id);
    await db
      .prepare(`DELETE FROM linkedin_campaign_channel_actions WHERE workspace_id=? AND member_id=?`)
      .run(WORKSPACE, member.id);
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_channel_actions
           (id,workspace_id,campaign_id,member_id,contact_id,workflow_step_id,kind,status,planned_for,payload_json,idempotency_key,created_at,updated_at)
           VALUES ('licha_basis_send',?,?,?,?,?,'email','planned',?::timestamptz,?::jsonb,'basis-send-key',?::timestamptz,?::timestamptz)`
      )
      .run(
        WORKSPACE,
        campaignId,
        member.id,
        member.contactId,
        'email-live',
        NOW.toISOString(),
        JSON.stringify({
          recipient: 'maya@acme-gmbh.de',
          subject: 'Tracked email',
          body: 'See https://example.com/demo for details',
          tracking: 'opens_clicks',
          threaded: false
        }),
        NOW.toISOString(),
        NOW.toISOString()
      );

    const run = await runCampaignChannelActions(db, WORKSPACE, NOW);
    expect(run).toMatchObject({ sent: 0, failed: 0, unknown: 0 });
    const action = await db
      .prepare(
        `SELECT status,last_error,tracking_token FROM linkedin_campaign_channel_actions WHERE id='licha_basis_send'`
      )
      .get<{ status: string; last_error: string | null; tracking_token: string | null }>();
    expect(action?.status).toBe('skipped');
    expect(action?.last_error).toContain('Lawful basis missing for cold email');
    expect(action?.last_error).toContain('recipient in DE');
    expect(action?.last_error).toContain('Not legal advice; verify with counsel.');
    expect(action?.last_error).not.toContain('acme-gmbh');
    expect(action?.tracking_token).toBeNull();
    const links = await db
      .prepare(
        `SELECT token FROM linkedin_campaign_email_tracking_links WHERE workspace_id=? AND channel_action_id='licha_basis_send'`
      )
      .all<{ token: string }>(WORKSPACE);
    expect(links).toEqual([]);
    const after = (await listCampaignMembers(db, WORKSPACE, campaignId))[0]!;
    expect(after.status).toBe('excluded');
    expect(after.branchState['external:email_success']).toBeUndefined();
  });

  it('refuses to send or track a campaign email when its lead was marked do-not-contact', async () => {
    const campaignId = await campaignFor(
      [
        {
          id: 'wait',
          action: 'wait',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { duration: { amount: 1, unit: 'days' } }
        },
        {
          id: 'end',
          action: 'end',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { outcome: 'completed' }
        }
      ],
      'First Name,Last Name,Company,Email,LinkedIn URL\nMaya,NoContact,Acme,maya@example.com,https://linkedin.com/in/maya-campaign-dnc\n'
    );
    await runManagedCampaigns(db, WORKSPACE, NOW);
    const member = (await listCampaignMembers(db, WORKSPACE, campaignId))[0]!;
    await db
      .prepare(
        'UPDATE linkedin_lead_contacts SET do_not_contact=TRUE WHERE workspace_id=? AND id=?'
      )
      .run(WORKSPACE, member.contactId);
    await db
      .prepare(
        "UPDATE linkedin_campaign_members SET status='waiting',current_step_id='wait',step_index=0,next_eligible_at=?::timestamptz WHERE workspace_id=? AND id=?"
      )
      .run(NOW.toISOString(), WORKSPACE, member.id);
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_channel_actions
         (id,workspace_id,campaign_id,member_id,contact_id,workflow_step_id,kind,status,planned_for,payload_json,idempotency_key,created_at,updated_at)
       VALUES ('licha_dnc',?,?,?,?,?,'email','planned',?::timestamptz,?::jsonb,'dnc-key',?::timestamptz,?::timestamptz)`
      )
      .run(
        WORKSPACE,
        campaignId,
        member.id,
        member.contactId,
        'wait',
        NOW.toISOString(),
        JSON.stringify({
          recipient: 'maya@example.com',
          subject: 'Hello',
          body: 'See https://example.com/tracked',
          tracking: 'opens_clicks'
        }),
        NOW.toISOString(),
        NOW.toISOString()
      );
    const run = await runCampaignChannelActions(db, WORKSPACE, NOW);
    expect(run).toMatchObject({ sent: 0, failed: 0, unknown: 0 });
    const refused = await db
      .prepare(
        "SELECT status,last_error,tracking_token FROM linkedin_campaign_channel_actions WHERE id='licha_dnc'"
      )
      .get<{ status: string; last_error: string | null; tracking_token: string | null }>();
    expect(refused?.status).toBe('skipped');
    expect(refused?.last_error).toContain('do-not-contact');
    expect((await listCampaignMembers(db, WORKSPACE, campaignId))[0]?.status).toBe('excluded');
    expect(refused?.tracking_token).toBeNull();
  });

  it('records native tracking opens/clicks and resolves click redirects only from opaque token pairs', async () => {
    const campaignId = await campaignFor(
      [
        {
          id: 'wait',
          action: 'wait',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { duration: { amount: 1, unit: 'days' } }
        },
        {
          id: 'end',
          action: 'end',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { outcome: 'completed' }
        }
      ],
      'First Name,Last Name,Company,Email,LinkedIn URL\nMaya,Smith,Acme,maya@example.com,https://linkedin.com/in/maya-tracked\n'
    );
    await runManagedCampaigns(db, WORKSPACE, NOW);
    const member = (await listCampaignMembers(db, WORKSPACE, campaignId))[0]!;
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_channel_actions
         (id,workspace_id,campaign_id,member_id,contact_id,workflow_step_id,kind,status,planned_for,payload_json,idempotency_key,completed_at,external_ref,provider,tracking_token,created_at,updated_at)
         VALUES ('licha_track',?,?,?,?,?,'email','sent',?::timestamptz,'{}'::jsonb,'track-key',?::timestamptz,'mail-track','gmail','opaque-open-token',?::timestamptz,?::timestamptz)`
      )
      .run(
        WORKSPACE,
        campaignId,
        member.id,
        member.contactId,
        'email-track-step',
        NOW.toISOString(),
        NOW.toISOString(),
        NOW.toISOString(),
        NOW.toISOString()
      );
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_email_tracking_links
         (token,workspace_id,channel_action_id,target_url,created_at)
         VALUES ('opaque-link-token',?,'licha_track','https://example.com/demo',?::timestamptz)`
      )
      .run(WORKSPACE, NOW.toISOString());

    expect(await recordCampaignEmailTrackingOpen(db, 'opaque-open-token', NOW)).toBe(true);
    expect(
      await recordCampaignEmailTrackingClick(db, 'opaque-open-token', 'opaque-link-token', NOW)
    ).toBe('https://example.com/demo');
    expect(
      await recordCampaignEmailTrackingClick(db, 'wrong-token', 'opaque-link-token', NOW)
    ).toBeNull();
    const events = await db
      .prepare(
        `SELECT event_kind FROM linkedin_campaign_email_events WHERE workspace_id=? AND channel_action_id='licha_track' ORDER BY event_kind`
      )
      .all<{ event_kind: string }>(WORKSPACE);
    expect(events.map((row) => row.event_kind)).toEqual(['clicked', 'opened']);
    const refreshed = (await listCampaignMembers(db, WORKSPACE, campaignId))[0]!;
    expect(refreshed.branchState['external:email_opened']).toBe(true);
    expect(refreshed.branchState['external:email_clicked']).toBe(true);
  });

  it('polls mailbox thread telemetry automatically and a detected reply stops queued work', async () => {
    const campaignId = await campaignFor(
      [
        {
          id: 'wait',
          action: 'wait',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { duration: { amount: 1, unit: 'days' } }
        },
        {
          id: 'end',
          action: 'end',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { outcome: 'completed' }
        }
      ],
      'First Name,Last Name,Company,Email,LinkedIn URL\nMaya,Smith,Acme,maya@example.com,https://linkedin.com/in/maya-provider-reply\n'
    );
    await runManagedCampaigns(db, WORKSPACE, NOW);
    const member = (await listCampaignMembers(db, WORKSPACE, campaignId))[0]!;
    await db
      .prepare(
        `INSERT INTO connections
         (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,created_at,updated_at)
         VALUES ('conn_mail',?,'gmail','trevra-gmail','ext-mail','owner@example.com','connected',0,?::timestamptz,?::timestamptz)`
      )
      .run(WORKSPACE, NOW.toISOString(), NOW.toISOString());
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_channel_actions
         (id,workspace_id,campaign_id,member_id,contact_id,workflow_step_id,kind,status,planned_for,payload_json,idempotency_key,connection_id,completed_at,external_ref,provider,created_at,updated_at)
         VALUES ('licha_provider',?,?,?,?,?,'email','sent',?::timestamptz,?::jsonb,'provider-key','conn_mail',?::timestamptz,'gmail-sent','gmail',?::timestamptz,?::timestamptz)`
      )
      .run(
        WORKSPACE,
        campaignId,
        member.id,
        member.contactId,
        'email-provider-step',
        NOW.toISOString(),
        JSON.stringify({ recipient: 'maya@example.com' }),
        NOW.toISOString(),
        NOW.toISOString(),
        NOW.toISOString()
      );
    await db
      .prepare(
        `INSERT INTO linkedin_actions
         (id,workspace_id,seat_key,kind,target_ref,status,planned_for,campaign_id,campaign_member_id,workflow_step_id,source,replay_scope,created_at)
         VALUES ('lact_after_email_reply',?,'owner','dm','https://linkedin.com/in/maya-provider-reply','planned',?::timestamptz,?,?, 'future-dm','campaign','future-reply',?::timestamptz)`
      )
      .run(WORKSPACE, NOW.toISOString(), campaignId, member.id, NOW.toISOString());

    const synced = await syncCampaignEmailProviderEvents(db, WORKSPACE, NOW, 50, async () => [
      {
        kind: 'reply',
        providerEventId: 'gmail:reply-1',
        occurredAt: '2026-08-20T09:01:00.000Z'
      }
    ]);
    expect(synced).toMatchObject({ checked: 1, replied: 1, bounced: 0, failed: 0 });
    expect((await listCampaignMembers(db, WORKSPACE, campaignId))[0]?.status).toBe('replied');
    expect(
      await db
        .prepare(`SELECT status FROM linkedin_actions WHERE id='lact_after_email_reply'`)
        .get<{ status: string }>()
    ).toEqual({ status: 'skipped' });
  });
});
