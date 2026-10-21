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
import { putWorkspaceSecret } from '../secrets/store.js';
import { queueEnrichmentRun } from '../enrichment/runs.js';
import {
  createSuppression,
  findSuppression,
  liftSuppression,
  withSuppressionBoundary
} from '../suppressions.js';
import { executeConnectedAction } from '../integration-service.js';
import { addExclusions } from './exclusions.js';
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
let createdListCount = 0;

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
    'linkedin_exclusions',
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
  // This suite creates durable opt-out records; isolate each recipient fixture.
  await db.prepare('DELETE FROM suppressions WHERE workspace_id=?').run(WORKSPACE);
  await db.prepare('DELETE FROM email_inbound_mailboxes WHERE workspace_id=?').run(WORKSPACE);
  await db.prepare('DELETE FROM email_deliverability_checks WHERE workspace_id=?').run(WORKSPACE);
  await db.prepare('DELETE FROM connections WHERE workspace_id=?').run(WORKSPACE);
  await db
    .prepare('DELETE FROM linkedin_campaign_email_approvals WHERE workspace_id=?')
    .run(WORKSPACE);
  await db.prepare('DELETE FROM workspace_policies WHERE workspace_id=?').run(WORKSPACE);
  await db
    .prepare('DELETE FROM workspace_secrets WHERE workspace_id=? AND kind=?')
    .run(WORKSPACE, 'hunter_api_key');
  await db.prepare('DELETE FROM enrichment_usage_ledger WHERE workspace_id=?').run(WORKSPACE);
  await db.prepare('DELETE FROM enrichment_runs WHERE workspace_id=?').run(WORKSPACE);
  await db.prepare('DELETE FROM enrichment_settings WHERE workspace_id=?').run(WORKSPACE);
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
  vi.unstubAllGlobals();
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
  const list = await createLeadList(
    db,
    { workspaceId: WORKSPACE, name: `Leads ${++createdListCount}` },
    NOW
  );
  await importLeadCsv(db, { workspaceId: WORKSPACE, listId: list.id, csv }, NOW);
  const workflow = await saveWorkflow(
    db,
    { workspaceId: WORKSPACE, name: `Channel flow ${createdListCount}`, steps },
    NOW
  );
  const created = await createManagedCampaign(
    db,
    {
      workspaceId: WORKSPACE,
      name: `Channel campaign ${createdListCount}`,
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

async function queuedReviewPair(first: string, second: string): Promise<void> {
  await queuedReviewEmail(first);
  await queuedReviewEmail(second);
  // The second campaign creation also ticks the first campaign. Restore both
  // fixture members to their manually queued email step so either order may send.
  await db
    .prepare(
      `UPDATE linkedin_campaign_members
       SET status='waiting',current_step_id='review-email',step_index=0,
           next_eligible_at=?::timestamptz
       WHERE workspace_id=? AND id IN (
         SELECT member_id FROM linkedin_campaign_channel_actions
         WHERE workspace_id=? AND id IN (?,?)
       )`
    )
    .run(NOW.toISOString(), WORKSPACE, WORKSPACE, first, second);
  await db
    .prepare(
      `UPDATE linkedin_campaigns SET status='running'
       WHERE workspace_id=? AND id IN (
         SELECT campaign_id FROM linkedin_campaign_channel_actions
         WHERE workspace_id=? AND id IN (?,?)
       )`
    )
    .run(WORKSPACE, WORKSPACE, first, second);
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
    await expect(
      executeConnectedAction(db, WORKSPACE, {
        type: 'email_draft',
        connection_id: 'conn_campaign_live',
        require_connection_id: true,
        recipient: review.recipient,
        subject: review.subject,
        body: review.body + '\n\n' + review.footer,
        payload_hash: 'forged-html-envelope',
        structured_payload_json: JSON.stringify({
          deliverySourceType: 'campaign_email',
          deliverySourceId: review.actionId,
          approvalContentHash: review.contentHash,
          contactId: person!.contact_id,
          personId: person!.person_id,
          senderAddress: review.sender,
          tracking: review.tracking,
          threaded: review.threaded,
          htmlBody: '<b>Unapproved HTML payload</b>',
          deliveryPurpose: 'outreach',
          requireListUnsubscribe: true,
          unsubscribeMode: 'list_unsubscribe_headers'
        })
      })
    ).rejects.toThrow('Unapproved campaign HTML');
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
  it('defers due email actions on broken mailbox setup and resumes after recovery', async () => {
    await seedReadyMailbox();
    await queuedReviewPair('licha_setup_first', 'licha_setup_second');
    await db.prepare('DELETE FROM email_inbound_mailboxes WHERE workspace_id=?').run(WORKSPACE);
    const held = await runCampaignChannelActions(db, WORKSPACE, NOW);
    expect(held).toMatchObject({ claimed: 1, sent: 0, failed: 0, unknown: 0 });
    expect(nangoMock.post).not.toHaveBeenCalled();
    const deferred = await db
      .prepare(
        `SELECT status,attempt_count,last_error,planned_for
         FROM linkedin_campaign_channel_actions
         WHERE workspace_id=? AND id IN ('licha_setup_first','licha_setup_second')
         ORDER BY id`
      )
      .all<{ status: string; attempt_count: number; last_error: string; planned_for: string }>(
        WORKSPACE
      );
    expect(deferred).toHaveLength(2);
    expect(deferred.map((item) => item.attempt_count).sort()).toEqual([0, 1]);
    for (const action of deferred) {
      expect(action.status).toBe('planned');
      expect(action.last_error).toContain('Replies are not syncing');
      expect(new Date(action.planned_for).getTime()).toBe(NOW.getTime() + 3_600_000);
    }
    await db
      .prepare(
        `INSERT INTO email_inbound_mailboxes
         (workspace_id,connection_id,address,sync_status,designated_at,updated_at)
         VALUES (?,'conn_campaign_live','founder@acme.test','syncing',?::timestamptz,?::timestamptz)`
      )
      .run(WORKSPACE, NOW.toISOString(), NOW.toISOString());
    expect(
      await runCampaignChannelActions(db, WORKSPACE, new Date(NOW.getTime() + 3_600_000))
    ).toMatchObject({ claimed: 2, sent: 2 });
    expect(nangoMock.post).toHaveBeenCalledTimes(2);
  });

  it('reserves one mailbox daily slot across concurrent workers before provider confirmation', async () => {
    await seedReadyMailbox();
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_mailbox_settings
         (workspace_id,connection_id,daily_limit,timezone,working_days_json,
          work_start_minute,work_end_minute)
         VALUES (?,'conn_campaign_live',1,'UTC','[1,2,3,4,5]'::jsonb,480,1080)`
      )
      .run(WORKSPACE);
    await queuedReviewPair('licha_capacity_first', 'licha_capacity_second');

    let providerStarted!: () => void;
    let releaseProvider!: () => void;
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    nangoMock.post.mockImplementation(async () => {
      providerStarted();
      await pending;
      return { data: { id: 'mailbox-cap-send', threadId: 'mailbox-cap-thread' }, headers: {} };
    });

    const first = runCampaignChannelActions(db, WORKSPACE, NOW, 1);
    try {
      await started;
      // A distinct executor can claim through another pooled PostgreSQL connection
      // while the first provider call is still pending.
      const second = await runCampaignChannelActions(db, WORKSPACE, NOW, 1);
      expect(second).toMatchObject({ claimed: 0, sent: 0, failed: 0, unknown: 0 });
      expect(nangoMock.post).toHaveBeenCalledTimes(1);
    } finally {
      releaseProvider();
    }
    expect(await first).toMatchObject({ claimed: 1, sent: 1 });
    expect((await runCampaignChannelActions(db, WORKSPACE, NOW, 1)).claimed).toBe(0);
    expect(
      await db
        .prepare(
          `SELECT status,COUNT(*)::int AS total
           FROM linkedin_campaign_channel_actions
           WHERE workspace_id=? AND id IN ('licha_capacity_first','licha_capacity_second')
           GROUP BY status ORDER BY status`
        )
        .all<{ status: string; total: number }>(WORKSPACE)
    ).toEqual([
      { status: 'planned', total: 1 },
      { status: 'sent', total: 1 }
    ]);
  });

  it('reserves mailbox capacity for an unresolved email provider outcome', async () => {
    await seedReadyMailbox();
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_mailbox_settings
         (workspace_id,connection_id,daily_limit,timezone,working_days_json,
          work_start_minute,work_end_minute)
         VALUES (?,'conn_campaign_live',1,'UTC','[1,2,3,4,5]'::jsonb,480,1080)`
      )
      .run(WORKSPACE);
    await queuedReviewPair('licha_unknown_slot', 'licha_unknown_next');
    nangoMock.post.mockRejectedValueOnce(new Error('Network lost after provider acceptance'));
    expect(await runCampaignChannelActions(db, WORKSPACE, NOW, 1)).toMatchObject({
      claimed: 1,
      sent: 0,
      unknown: 1
    });
    expect((await runCampaignChannelActions(db, WORKSPACE, NOW, 1)).claimed).toBe(0);
    expect(nangoMock.post).toHaveBeenCalledTimes(1);
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

  it('finds an email with the sealed workspace Hunter key and advances the branch only once', async () => {
    await db
      .prepare(
        "INSERT INTO enrichment_settings(workspace_id,monthly_credit_cap,key_status) VALUES (?,1,'valid')"
      )
      .run(WORKSPACE);
    vi.stubEnv('TREVRA_SECRETS_KEY', Buffer.alloc(32, 7).toString('base64'));
    await putWorkspaceSecret(db, {
      workspaceId: WORKSPACE,
      kind: 'hunter_api_key',
      plaintext: 'hunter-workspace-fixture-key'
    });
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)['X-API-KEY']).toBe(
        'hunter-workspace-fixture-key'
      );
      return new Response(
        JSON.stringify({
          data: {
            email: 'MAYA@EXAMPLE.COM',
            score: 93,
            verification: { status: 'valid' },
            source_type: 'found'
          }
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    });
    vi.stubGlobal('fetch', fetchImpl);
    const campaignId = await campaignFor(
      [
        {
          id: 'find',
          action: 'find_email',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { providerId: 'hunter', refresh: false }
        },
        {
          id: 'end',
          action: 'end',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { outcome: 'completed' }
        }
      ],
      'First Name,Last Name,Company,LinkedIn URL\nMaya,Smith,Example,https://linkedin.com/in/maya-hunter\n',
      { enrichmentCreditCap: 1 }
    );
    await runManagedCampaigns(db, WORKSPACE, NOW);
    const action = await db
      .prepare(
        "SELECT status,provider,external_ref,credits_used FROM linkedin_campaign_channel_actions WHERE workspace_id=? AND campaign_id=? AND kind='find_email'"
      )
      .get<{ status: string; provider: string; external_ref: string; credits_used: number }>(
        WORKSPACE,
        campaignId
      );
    expect(action).toMatchObject({
      status: 'sent',
      provider: 'hunter',
      external_ref: 'email:maya@example.com',
      credits_used: 1
    });
    const contact = await db
      .prepare(
        'SELECT email,email_source,email_confidence,email_verification_status FROM linkedin_lead_contacts WHERE workspace_id=?'
      )
      .get<{
        email: string;
        email_source: string;
        email_confidence: number;
        email_verification_status: string;
      }>(WORKSPACE);
    expect(contact?.email).toBe('maya@example.com');
    expect(contact?.email_source).toBe('hunter');
    expect(Number(contact?.email_confidence)).toBeCloseTo(0.93);
    expect(contact?.email_verification_status).toBe('valid');
    expect(
      (await listCampaignMembers(db, WORKSPACE, campaignId))[0]?.branchState['external:email_found']
    ).toBe(true);
    await runCampaignChannelActions(db, WORKSPACE, new Date(NOW.getTime() + 60000));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetchImpl.mock.calls[0]?.[0])).searchParams.has('api_key')).toBe(false);
    expect(
      await db
        .prepare(
          "SELECT provider,operation,credits FROM enrichment_usage_ledger WHERE workspace_id=? AND run_id=(SELECT id FROM linkedin_campaign_channel_actions WHERE campaign_id=? AND kind='find_email')"
        )
        .get<{ provider: string; operation: string; credits: number }>(WORKSPACE, campaignId)
    ).toMatchObject({ provider: 'hunter', operation: 'email_finder', credits: 1 });
  });

  it('holds the same campaign node until the workspace Hunter key is connected without charging', async () => {
    vi.stubEnv('TREVRA_SECRETS_KEY', Buffer.alloc(32, 7).toString('base64'));
    const fetchImpl = vi.fn(async () => {
      throw new Error('This provider must not be called');
    });
    vi.stubGlobal('fetch', fetchImpl);
    const campaignId = await campaignFor(
      [
        {
          id: 'find',
          action: 'find_email',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { providerId: 'hunter', refresh: false }
        },
        {
          id: 'end',
          action: 'end',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { outcome: 'completed' }
        }
      ],
      'First Name,Last Name,Company,LinkedIn URL\nMaya,Smith,Example,https://linkedin.com/in/maya-nokey\n',
      { enrichmentCreditCap: 1 }
    );
    await runManagedCampaigns(db, WORKSPACE, NOW);
    const action = await db
      .prepare(
        "SELECT status,credits_used,last_error FROM linkedin_campaign_channel_actions WHERE workspace_id=? AND campaign_id=? AND kind='find_email'"
      )
      .get<{ status: string; credits_used: number; last_error: string }>(WORKSPACE, campaignId);
    expect(action?.status).toBe('planned');
    expect(action?.credits_used).toBe(0);
    expect(action?.last_error).toContain('Hunter API key not connected');
    const member = (await listCampaignMembers(db, WORKSPACE, campaignId))[0]!;
    expect(member.branchState['external:email_found']).toBeUndefined();
    expect(
      (
        await db
          .prepare(
            'SELECT count(*)::int AS count FROM enrichment_usage_ledger WHERE workspace_id=?'
          )
          .get<{ count: number }>(WORKSPACE)
      )?.count
    ).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();

    // The exact action remains queued: connecting Hunter resumes it without
    // re-enrolling the lead or advancing a false no-email branch.
    await putWorkspaceSecret(db, {
      workspaceId: WORKSPACE,
      kind: 'hunter_api_key',
      plaintext: 'hunter-after-onboarding'
    });
    await db
      .prepare(
        "INSERT INTO enrichment_settings(workspace_id,monthly_credit_cap,key_status) VALUES (?,1,'valid')"
      )
      .run(WORKSPACE);
    const readyFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: { email: 'ready@example.com', score: 91, verification: { status: 'valid' } }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );
    vi.stubGlobal('fetch', readyFetch);
    await runCampaignChannelActions(db, WORKSPACE, new Date(NOW.getTime() + 61 * 60000));
    const resumed = await db
      .prepare(
        "SELECT status,credits_used,external_ref FROM linkedin_campaign_channel_actions WHERE workspace_id=? AND campaign_id=? AND kind='find_email'"
      )
      .get<{ status: string; credits_used: number; external_ref: string }>(WORKSPACE, campaignId);
    expect(resumed).toMatchObject({
      status: 'sent',
      credits_used: 1,
      external_ref: 'email:ready@example.com'
    });
    expect(
      (await listCampaignMembers(db, WORKSPACE, campaignId))[0]?.branchState['external:email_found']
    ).toBe(true);
    expect(readyFetch).toHaveBeenCalledTimes(1);
  });

  it('never calls Hunter or charges a credit for a lead marked do-not-contact', async () => {
    await db
      .prepare(
        "INSERT INTO enrichment_settings(workspace_id,monthly_credit_cap,key_status) VALUES (?,1,'valid')"
      )
      .run(WORKSPACE);
    vi.stubEnv('TREVRA_SECRETS_KEY', Buffer.alloc(32, 7).toString('base64'));
    await putWorkspaceSecret(db, {
      workspaceId: WORKSPACE,
      kind: 'hunter_api_key',
      plaintext: 'hunter-no-optouts'
    });
    const fetchImpl = vi.fn(async () => {
      throw new Error('Do-not-contact lookup reached provider');
    });
    vi.stubGlobal('fetch', fetchImpl);
    const campaignId = await campaignFor(
      [
        {
          id: 'find',
          action: 'find_email',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { providerId: 'hunter', refresh: false }
        },
        {
          id: 'end',
          action: 'end',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { outcome: 'completed' }
        }
      ],
      'First Name,Last Name,Company,LinkedIn URL\nMaya,Smith,Example,https://linkedin.com/in/maya-private\n',
      { enrichmentCreditCap: 1 }
    );
    await db
      .prepare('UPDATE linkedin_lead_contacts SET do_not_contact=TRUE WHERE workspace_id=?')
      .run(WORKSPACE);
    await runManagedCampaigns(db, WORKSPACE, NOW);
    expect(fetchImpl).not.toHaveBeenCalled();
    const usage = await db
      .prepare('SELECT count(*)::int AS total FROM enrichment_usage_ledger WHERE workspace_id=?')
      .get<{ total: number }>(WORKSPACE);
    expect(usage?.total).toBe(0);
    const member = (await listCampaignMembers(db, WORKSPACE, campaignId))[0];
    expect(member?.branchState['external:email_found']).not.toBe(true);
  });

  it('returns no email and frees the campaign reservation when Hunter finds nothing', async () => {
    await db
      .prepare(
        "INSERT INTO enrichment_settings(workspace_id,monthly_credit_cap,key_status) VALUES (?,1,'valid')"
      )
      .run(WORKSPACE);
    vi.stubEnv('TREVRA_SECRETS_KEY', Buffer.alloc(32, 7).toString('base64'));
    await putWorkspaceSecret(db, {
      workspaceId: WORKSPACE,
      kind: 'hunter_api_key',
      plaintext: 'hunter-workspace-fixture-key'
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: { email: null } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
      )
    );
    const campaignId = await campaignFor(
      [
        {
          id: 'find',
          action: 'find_email',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { providerId: 'hunter', refresh: false }
        },
        {
          id: 'end',
          action: 'end',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { outcome: 'completed' }
        }
      ],
      'First Name,Last Name,Company,LinkedIn URL\nMaya,Smith,Example,https://linkedin.com/in/maya-noresult\n',
      { enrichmentCreditCap: 1 }
    );
    await runManagedCampaigns(db, WORKSPACE, NOW);
    const action = await db
      .prepare(
        "SELECT status,credits_used,external_ref FROM linkedin_campaign_channel_actions WHERE workspace_id=? AND campaign_id=? AND kind='find_email'"
      )
      .get<{ status: string; credits_used: number; external_ref: string }>(WORKSPACE, campaignId);
    expect(action).toMatchObject({
      status: 'sent',
      credits_used: 0,
      external_ref: 'email:not-found'
    });
    const usage = await db
      .prepare(
        "SELECT credits FROM enrichment_usage_ledger WHERE workspace_id=? AND run_id=(SELECT id FROM linkedin_campaign_channel_actions WHERE campaign_id=? AND kind='find_email')"
      )
      .get<{ credits: number }>(WORKSPACE, campaignId);
    expect(Number(usage?.credits)).toBe(0);
    expect(
      (await listCampaignMembers(db, WORKSPACE, campaignId))[0]?.branchState['external:email_found']
    ).toBe(false);
  });

  it('does not spend finder credits already reserved for an approved workspace enrichment run', async () => {
    await db
      .prepare(
        "INSERT INTO enrichment_settings(workspace_id,monthly_credit_cap,key_status) VALUES (?,1,'valid')"
      )
      .run(WORKSPACE);
    await db
      .prepare(
        'INSERT INTO users(id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?::timestamptz) ON CONFLICT (id) DO NOTHING'
      )
      .run(
        'usr_finder_budget_test',
        WORKSPACE,
        'finder-budget@test.trevra.local',
        'Budget tester',
        NOW.toISOString()
      );
    await queueEnrichmentRun(
      db,
      {
        workspaceId: WORKSPACE,
        actorType: 'user',
        actorUserId: 'usr_finder_budget_test',
        idempotencyKey: 'reserve-before-campaign',
        planHash: 'hunter-estimate-fixture',
        domains: ['example.com'],
        emailsPerDomain: 1,
        includeUnverified: false,
        estimatedCredits: 1
      },
      NOW
    );
    vi.stubEnv('TREVRA_SECRETS_KEY', Buffer.alloc(32, 7).toString('base64'));
    await putWorkspaceSecret(db, {
      workspaceId: WORKSPACE,
      kind: 'hunter_api_key',
      plaintext: 'hunter-queued-run'
    });
    const fetchImpl = vi.fn(async () => {
      throw new Error('Cap bypassed');
    });
    vi.stubGlobal('fetch', fetchImpl);
    const campaignId = await campaignFor(
      [
        {
          id: 'find',
          action: 'find_email',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { providerId: 'hunter', refresh: false }
        },
        {
          id: 'end',
          action: 'end',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { outcome: 'completed' }
        }
      ],
      'First Name,Last Name,Company,LinkedIn URL\nMaya,Smith,Example,https://linkedin.com/in/maya-reserved\n',
      { enrichmentCreditCap: 1 }
    );
    await runManagedCampaigns(db, WORKSPACE, NOW);
    const action = await db
      .prepare(
        "SELECT status,credits_used,last_error FROM linkedin_campaign_channel_actions WHERE workspace_id=? AND campaign_id=? AND kind='find_email'"
      )
      .get<{ status: string; credits_used: number; last_error: string }>(WORKSPACE, campaignId);
    expect(action).toMatchObject({
      status: 'planned',
      credits_used: 0
    });
    expect(action?.last_error).toContain('monthly credit cap reached');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      (
        await db
          .prepare(
            'SELECT COALESCE(SUM(credits),0)::int AS total FROM enrichment_usage_ledger WHERE workspace_id=?'
          )
          .get<{ total: number }>(WORKSPACE)
      )?.total
    ).toBe(0);
  });

  it('shares the workspace monthly cap with ordinary enrichment and refuses the next provider call', async () => {
    await db
      .prepare(
        "INSERT INTO enrichment_settings(workspace_id,monthly_credit_cap,key_status) VALUES (?,1,'valid')"
      )
      .run(WORKSPACE);
    vi.stubEnv('TREVRA_SECRETS_KEY', Buffer.alloc(32, 7).toString('base64'));
    await putWorkspaceSecret(db, {
      workspaceId: WORKSPACE,
      kind: 'hunter_api_key',
      plaintext: 'hunter-fixture-budget'
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { email: 'found@example.com', score: 97 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
    );
    vi.stubGlobal('fetch', fetchImpl);
    const campaignId = await campaignFor(
      [
        {
          id: 'find',
          action: 'find_email',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { providerId: 'hunter', refresh: false }
        },
        {
          id: 'end',
          action: 'end',
          delayBefore: { amount: 0, unit: 'hours' },
          config: { outcome: 'completed' }
        }
      ],
      'First Name,Last Name,Company,LinkedIn URL\nMaya,One,Example,https://linkedin.com/in/maya-monthly-cap\nJon,Two,Example,https://linkedin.com/in/jon-monthly-cap\n',
      { enrichmentCreditCap: 2 }
    );
    await runManagedCampaigns(db, WORKSPACE, NOW);
    const actions = await db
      .prepare(
        "SELECT status,credits_used,last_error FROM linkedin_campaign_channel_actions WHERE workspace_id=? AND campaign_id=? AND kind='find_email' ORDER BY id"
      )
      .all<{ status: string; credits_used: number; last_error: string | null }>(
        WORKSPACE,
        campaignId
      );
    expect(actions).toHaveLength(2);
    expect(actions.map((item) => item.status).sort()).toEqual(['planned', 'sent']);
    expect(actions.some((item) => /monthly credit cap reached/.test(item.last_error ?? ''))).toBe(
      true
    );
    expect(actions.reduce((sum, item) => sum + Number(item.credits_used), 0)).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const charged = await db
      .prepare(
        "SELECT SUM(credits)::numeric AS charged FROM enrichment_usage_ledger WHERE workspace_id=? AND operation='email_finder'"
      )
      .get<{ charged: number }>(WORKSPACE);
    expect(Number(charged?.charged)).toBe(1);
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
    expect((await listCampaignMembers(db, WORKSPACE, campaignId))[0]?.status).toBe('excluded');
    expect(
      await recordCampaignEmailEvent(
        db,
        WORKSPACE,
        {
          channelActionId: 'licha_bounce',
          eventKind: 'bounce',
          providerEventId: 'provider-bounce-1'
        },
        NOW
      )
    ).toMatchObject({ recorded: false });
    expect(
      (
        await db
          .prepare(
            "SELECT COUNT(*)::int AS total FROM linkedin_campaign_email_events WHERE workspace_id=? AND channel_action_id='licha_bounce'"
          )
          .get<{ total: number }>(WORKSPACE)
      )?.total
    ).toBe(1);
  });

  it('ignores fabricated email events for unsent or unresolved channel actions', async () => {
    await seedReadyMailbox();
    await queuedReviewEmail('licha_unsent_event');
    for (const status of ['planned', 'claimed', 'unknown', 'failed', 'skipped']) {
      await db
        .prepare(
          'UPDATE linkedin_campaign_channel_actions SET status=? WHERE workspace_id=? AND id=?'
        )
        .run(status, WORKSPACE, 'licha_unsent_event');
      const result = await recordCampaignEmailEvent(
        db,
        WORKSPACE,
        {
          channelActionId: 'licha_unsent_event',
          eventKind: 'unsubscribe',
          providerEventId: `unsent-${status}`
        },
        NOW
      );
      expect(result).toEqual({ recorded: false, memberId: null });
    }
    expect(
      (
        await db
          .prepare(
            'SELECT COUNT(*)::int AS total FROM linkedin_campaign_email_events WHERE workspace_id=?'
          )
          .get<{ total: number }>(WORKSPACE)
      )?.total
    ).toBe(0);
    expect(
      await findSuppression(db, WORKSPACE, {
        channel: 'email',
        email: 'maya-review@example.com'
      })
    ).toBeNull();
  });

  it('a hard bounce atomically retires pending email and LinkedIn sends', async () => {
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
      'First Name,Last Name,Company,Email,LinkedIn URL\nPat,Lee,Acme,bounce-future@example.com,https://linkedin.com/in/bounce-future\n'
    );
    await runManagedCampaigns(db, WORKSPACE, NOW);
    const member = (await listCampaignMembers(db, WORKSPACE, campaignId))[0]!;
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_channel_actions
         (id,workspace_id,campaign_id,member_id,contact_id,workflow_step_id,kind,status,planned_for,payload_json,idempotency_key,completed_at,created_at,updated_at)
         VALUES ('licha_bounce_prior',?,?,?,?,?,'email','sent',?::timestamptz,'{}'::jsonb,'prior',?::timestamptz,?::timestamptz,?::timestamptz),
                ('licha_bounce_future',?,?,?,?,?,'email','planned',?::timestamptz,'{}'::jsonb,'future',NULL,?::timestamptz,?::timestamptz)`
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
        NOW.toISOString(),
        WORKSPACE,
        campaignId,
        member.id,
        member.contactId,
        'end',
        new Date(NOW.getTime() + 60_000).toISOString(),
        NOW.toISOString(),
        NOW.toISOString()
      );
    await recordCampaignEmailEvent(
      db,
      WORKSPACE,
      {
        channelActionId: 'licha_bounce_prior',
        eventKind: 'bounce',
        providerEventId: 'hard-bounce-future'
      },
      NOW
    );
    expect((await listCampaignMembers(db, WORKSPACE, campaignId))[0]?.status).toBe('excluded');
    expect(
      await db
        .prepare(
          "SELECT status FROM linkedin_campaign_channel_actions WHERE id='licha_bounce_future'"
        )
        .get<{ status: string }>()
    ).toEqual({ status: 'skipped' });
    expect(
      await findSuppression(db, WORKSPACE, { channel: 'email', email: 'bounce-future@example.com' })
    ).not.toBeNull();
  });

  it('stops other campaigns for the same Person without falsely attributing their reply', async () => {
    const steps: Parameters<typeof saveWorkflow>[1]['steps'] = [
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
    ];
    const csv =
      'First Name,Last Name,Company,Email,LinkedIn URL\n' +
      'Maya,Smith,Acme,maya-cross@example.com,https://linkedin.com/in/maya-cross\n';
    const firstId = await campaignFor(steps, csv);
    const secondId = await campaignFor(steps, csv);
    await runManagedCampaigns(db, WORKSPACE, NOW);
    const [first] = await listCampaignMembers(db, WORKSPACE, firstId);
    const [second] = await listCampaignMembers(db, WORKSPACE, secondId);
    expect(first?.id).toBeTruthy();
    expect(second?.id).toBeTruthy();
    const identity = await db
      .prepare('SELECT person_id FROM linkedin_lead_contacts WHERE workspace_id=? AND id=?')
      .get<{ person_id: string | null }>(WORKSPACE, first!.contactId);
    const identity2 = await db
      .prepare('SELECT person_id FROM linkedin_lead_contacts WHERE workspace_id=? AND id=?')
      .get<{ person_id: string | null }>(WORKSPACE, second!.contactId);
    expect(identity?.person_id).toBeTruthy();
    expect(identity?.person_id).toBe(identity2?.person_id);
    // The registry correctly enforces one actively enrolled Person per workspace.
    // Model a late reply to a completed earlier campaign while a later campaign
    // is actively queued: this is the real cross-campaign case.
    await db
      .prepare(
        "UPDATE linkedin_campaign_members SET status='completed' WHERE workspace_id=? AND id=?"
      )
      .run(WORKSPACE, first!.id);
    await db
      .prepare(
        `UPDATE linkedin_campaign_members SET status='waiting',next_eligible_at=?::timestamptz
         WHERE workspace_id=? AND id=?`
      )
      .run(NOW.toISOString(), WORKSPACE, second!.id);
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_channel_actions
         (id,workspace_id,campaign_id,member_id,contact_id,workflow_step_id,kind,status,planned_for,payload_json,idempotency_key,completed_at,created_at,updated_at)
         VALUES ('licha_cross_sent',?,?,?,?,?,'email','sent',?::timestamptz,'{}'::jsonb,'cross-sent',?::timestamptz,?::timestamptz,?::timestamptz),
                ('licha_cross_queued',?,?,?,?,?,'email','planned',?::timestamptz,'{}'::jsonb,'cross-queued',NULL,?::timestamptz,?::timestamptz)`
      )
      .run(
        WORKSPACE,
        firstId,
        first!.id,
        first!.contactId,
        'wait',
        NOW.toISOString(),
        NOW.toISOString(),
        NOW.toISOString(),
        NOW.toISOString(),
        WORKSPACE,
        secondId,
        second!.id,
        second!.contactId,
        'wait',
        NOW.toISOString(),
        NOW.toISOString(),
        NOW.toISOString()
      );
    await db
      .prepare(
        `INSERT INTO linkedin_actions
         (id,workspace_id,seat_key,kind,target_ref,status,planned_for,campaign_id,campaign_member_id,source,replay_scope,created_at)
         VALUES ('lact_cross_future',?,'owner','dm','https://linkedin.com/in/maya-cross','planned',?::timestamptz,?,?,'campaign','cross-future',?::timestamptz)`
      )
      .run(WORKSPACE, NOW.toISOString(), secondId, second!.id, NOW.toISOString());

    expect(
      await recordCampaignEmailEvent(
        db,
        WORKSPACE,
        {
          channelActionId: 'licha_cross_sent',
          eventKind: 'reply',
          providerEventId: 'cross-person-reply'
        },
        NOW
      )
    ).toMatchObject({ recorded: true, memberId: first!.id });
    const updatedFirst = (await listCampaignMembers(db, WORKSPACE, firstId))[0]!;
    const updatedSecond = (await listCampaignMembers(db, WORKSPACE, secondId))[0]!;
    expect(updatedFirst.status).toBe('replied');
    expect(updatedSecond.status).toBe('excluded');
    expect(updatedSecond.exclusionReason).toContain('another campaign');
    expect(
      await db
        .prepare(
          "SELECT status FROM linkedin_campaign_channel_actions WHERE id='licha_cross_queued'"
        )
        .get<{ status: string }>()
    ).toEqual({ status: 'skipped' });
    expect(
      await db
        .prepare("SELECT status FROM linkedin_actions WHERE id='lact_cross_future'")
        .get<{ status: string }>()
    ).toEqual({ status: 'skipped' });
    const otherStats = await campaignOperationalAnalytics(db, WORKSPACE, secondId, NOW);
    expect(otherStats.funnel.replied).toBe(0);
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

  it('refuses a stale claimed campaign email at the shared send boundary after a reply or opt-out', async () => {
    await seedReadyMailbox();
    await queuedReviewEmail('licha_stale_claim');
    const review = (await previewCampaignEmail(db, WORKSPACE, 'licha_stale_claim'))!;
    const row = await db
      .prepare(
        `SELECT a.member_id,a.contact_id,c.person_id
         FROM linkedin_campaign_channel_actions a
         JOIN linkedin_lead_contacts c ON c.workspace_id=a.workspace_id AND c.id=a.contact_id
         WHERE a.workspace_id=? AND a.id=?`
      )
      .get<{ member_id: string; contact_id: string; person_id: string | null }>(
        WORKSPACE,
        review.actionId
      );
    expect(row?.person_id).toBeTruthy();
    // The worker had claimed a reviewed email before another channel observed a
    // reply. The final provider boundary must honor that newer member state.
    await db
      .prepare(
        "UPDATE linkedin_campaign_channel_actions SET status='claimed' WHERE workspace_id=? AND id=?"
      )
      .run(WORKSPACE, review.actionId);
    await db
      .prepare(
        "UPDATE linkedin_campaign_members SET status='excluded',exclusion_reason='Opted out elsewhere' WHERE workspace_id=? AND id=?"
      )
      .run(WORKSPACE, row!.member_id);
    await expect(
      executeConnectedAction(db, WORKSPACE, {
        type: 'email_draft',
        connection_id: review.connectionId,
        require_connection_id: true,
        recipient: review.recipient,
        subject: review.subject,
        body: `${review.body}\n\n${review.footer}`,
        payload_hash: 'stale-claim-provider-boundary',
        structured_payload_json: JSON.stringify({
          deliverySourceType: 'campaign_email',
          deliverySourceId: review.actionId,
          approvalContentHash: review.contentHash,
          contactId: row!.contact_id,
          personId: row!.person_id,
          senderAddress: review.sender,
          tracking: review.tracking,
          threaded: review.threaded,
          deliveryPurpose: 'outreach',
          requireListUnsubscribe: true,
          unsubscribeMode: 'list_unsubscribe_headers'
        })
      })
    ).rejects.toThrow('no longer current');
    expect(nangoMock.post).not.toHaveBeenCalled();
    expect(
      await db
        .prepare('SELECT COUNT(*)::int AS total FROM gtm_deliveries WHERE workspace_id=?')
        .get<{ total: number }>(WORKSPACE)
    ).toEqual({ total: 0 });
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

  it('rechecks Never Contact URL variants at the shared provider boundary after preflight', async () => {
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
      'First Name,Last Name,Company,Email,LinkedIn URL\nMaya,Smith,Acme,maya-never@example.com,https://linkedin.com/in/provider-new-exclusion?trk=stale\n'
    );
    const member = (await listCampaignMembers(db, WORKSPACE, campaignId))[0]!;
    const contact = await db
      .prepare('SELECT person_id FROM linkedin_lead_contacts WHERE workspace_id=? AND id=?')
      .get<{ person_id: string | null }>(WORKSPACE, member.contactId);
    expect(contact?.person_id).toBeTruthy();
    // The queued email was prepared before the operator excludes a canonical
    // URL variant. A stale already-claimed worker must still refuse the send.
    await addExclusions(
      db,
      WORKSPACE,
      [
        {
          targetRef: 'https://www.linkedin.com/in/provider-new-exclusion/?trk=new',
          reason: 'Opted out'
        }
      ],
      NOW
    );
    await expect(
      executeConnectedAction(db, WORKSPACE, {
        type: 'email_draft',
        connection_id: 'conn_campaign_live',
        require_connection_id: true,
        recipient: 'maya-never@example.com',
        subject: 'Hello',
        body: 'Hi Maya',
        payload_hash: 'provider-new-exclusion-no-send',
        structured_payload_json: JSON.stringify({
          deliverySourceType: 'campaign_email',
          deliverySourceId: 'licha_never_contact_race',
          deliveryPurpose: 'outreach',
          requireListUnsubscribe: true,
          unsubscribeMode: 'list_unsubscribe_headers',
          senderAddress: 'founder@acme.test',
          personId: contact!.person_id,
          contactId: member.contactId
        })
      })
    ).rejects.toThrow('Never Contact list');
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
         VALUES ('licha_track',?,?,?,?,?,'email','sent',?::timestamptz,'{"tracking":"off"}'::jsonb,'track-key',?::timestamptz,'mail-track','gmail','opaque-open-token',?::timestamptz,?::timestamptz)`
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

    // A random token alone cannot enable telemetry: an old prepared link may
    // survive an action whose persisted settings say tracking is off.
    expect(await recordCampaignEmailTrackingOpen(db, 'opaque-open-token', NOW)).toBe(false);
    expect(
      await recordCampaignEmailTrackingClick(db, 'opaque-open-token', 'opaque-link-token', NOW)
    ).toBe('https://example.com/demo');
    const eventCount = async () =>
      Number(
        (
          await db
            .prepare(
              "SELECT COUNT(*)::int AS count FROM linkedin_campaign_email_events WHERE workspace_id=? AND channel_action_id='licha_track'"
            )
            .get<{ count: number }>(WORKSPACE)
        )?.count ?? 0
      );
    expect(await eventCount()).toBe(0);

    // Legacy/malformed sent actions without a verified recipient cannot be tracked.
    await db
      .prepare('UPDATE linkedin_campaign_channel_actions SET payload_json=?::jsonb WHERE id=?')
      .run(JSON.stringify({ tracking: 'opens' }), 'licha_track');
    expect(await recordCampaignEmailTrackingOpen(db, 'opaque-open-token', NOW)).toBe(false);
    expect(await eventCount()).toBe(0);
    await db
      .prepare('UPDATE linkedin_campaign_channel_actions SET payload_json=?::jsonb WHERE id=?')
      .run(JSON.stringify({ recipient: 'maya@example.com', tracking: 'opens' }), 'licha_track');
    expect(await recordCampaignEmailTrackingOpen(db, 'opaque-open-token', NOW)).toBe(true);
    expect(
      await recordCampaignEmailTrackingClick(db, 'opaque-open-token', 'opaque-link-token', NOW)
    ).toBe('https://example.com/demo');
    expect(await eventCount()).toBe(1); // opens-only cannot record clicks.
    await db
      .prepare('UPDATE linkedin_campaign_channel_actions SET payload_json=?::jsonb WHERE id=?')
      .run(
        JSON.stringify({ recipient: 'maya@example.com', tracking: 'opens_clicks' }),
        'licha_track'
      );
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
  it('stops tracking after do-not-contact or email suppression, but preserves link destinations', async () => {
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
      'First Name,Last Name,Company,Email,LinkedIn URL\nMaya,Smith,Acme,maya@example.com,https://linkedin.com/in/maya-private-tracking\n'
    );
    await runManagedCampaigns(db, WORKSPACE, NOW);
    const member = (await listCampaignMembers(db, WORKSPACE, campaignId))[0]!;
    const action = 'licha_private_tracking';
    const token = 'opaque-private-tracking-token';
    const linkToken = 'opaque-private-link-token';
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_channel_actions
      (id,workspace_id,campaign_id,member_id,contact_id,workflow_step_id,kind,status,planned_for,payload_json,idempotency_key,completed_at,external_ref,provider,tracking_token,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'email','sent',?::timestamptz,?::jsonb,?,?::timestamptz,'mail-private','gmail',?,?::timestamptz,?::timestamptz)`
      )
      .run(
        action,
        WORKSPACE,
        campaignId,
        member.id,
        member.contactId,
        'email-private-step',
        NOW.toISOString(),
        JSON.stringify({ recipient: 'maya@example.com', tracking: 'opens_clicks' }),
        'private-tracking-key',
        NOW.toISOString(),
        token,
        NOW.toISOString(),
        NOW.toISOString()
      );
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_email_tracking_links
      (token,workspace_id,channel_action_id,target_url,created_at)
      VALUES (?,?,?,?,?::timestamptz)`
      )
      .run(
        linkToken,
        WORKSPACE,
        action,
        'https://example.com/recipient-resource',
        NOW.toISOString()
      );
    const eventCount = async () =>
      Number(
        (
          await db
            .prepare(
              'SELECT COUNT(*)::int AS count FROM linkedin_campaign_email_events WHERE workspace_id=? AND channel_action_id=?'
            )
            .get<{ count: number }>(WORKSPACE, action)
        )?.count ?? 0
      );

    // An insert failure in the optional telemetry sink must never break a
    // tracked link sent earlier. It must also leave no half-written event.
    await db.exec(`
      CREATE OR REPLACE FUNCTION trevra_test_fail_tracking_event() RETURNS trigger AS $$
      BEGIN
        IF NEW.workspace_id = '${WORKSPACE}' AND NEW.channel_action_id = '${action}' THEN
          RAISE EXCEPTION 'injected telemetry database failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER trevra_test_fail_tracking_event BEFORE INSERT
        ON linkedin_campaign_email_events FOR EACH ROW
        EXECUTE FUNCTION trevra_test_fail_tracking_event();
    `);
    try {
      expect(await recordCampaignEmailTrackingClick(db, token, linkToken, NOW)).toBe(
        'https://example.com/recipient-resource'
      );
      expect(await eventCount()).toBe(0);
    } finally {
      await db.exec(`DROP TRIGGER trevra_test_fail_tracking_event ON linkedin_campaign_email_events;
        DROP FUNCTION trevra_test_fail_tracking_event();`);
    }

    await db
      .prepare(
        'UPDATE linkedin_lead_contacts SET do_not_contact=TRUE WHERE workspace_id=? AND id=?'
      )
      .run(WORKSPACE, member.contactId);
    expect(await recordCampaignEmailTrackingOpen(db, token, NOW)).toBe(false);
    expect(await recordCampaignEmailTrackingClick(db, token, linkToken, NOW)).toBe(
      'https://example.com/recipient-resource'
    );
    expect(await eventCount()).toBe(0);

    await db
      .prepare(
        'UPDATE linkedin_lead_contacts SET do_not_contact=FALSE WHERE workspace_id=? AND id=?'
      )
      .run(WORKSPACE, member.contactId);
    // The lead was edited AFTER the old email was sent. Only the persisted
    // recipient identifies the mailbox whose tracking URL still exists.
    await db
      .prepare('UPDATE linkedin_lead_contacts SET email=? WHERE workspace_id=? AND id=?')
      .run('new@example.net', WORKSPACE, member.contactId);
    const oldRecipientSuppression = await createSuppression(
      db,
      {
        workspaceId: WORKSPACE,
        channel: 'email',
        email: 'maya@example.com',
        reason: 'Original recipient unsubscribed',
        source: 'test_opt_out'
      },
      NOW
    );
    expect(
      await findSuppression(db, WORKSPACE, { channel: 'email', email: 'maya@example.com' })
    ).not.toBeNull();
    expect(await recordCampaignEmailTrackingOpen(db, token, NOW)).toBe(false);
    expect(await recordCampaignEmailTrackingClick(db, token, linkToken, NOW)).toBe(
      'https://example.com/recipient-resource'
    );
    expect(await eventCount()).toBe(0);
    expect(
      (await listCampaignMembers(db, WORKSPACE, campaignId))[0]?.branchState[
        'external:email_opened'
      ]
    ).not.toBe(true);

    await liftSuppression(
      db,
      { workspaceId: WORKSPACE, suppressionId: oldRecipientSuppression.id, actorType: 'system' },
      NOW
    );
    // A later opt-out on the contact's edited address must also prevent
    // telemetry from tokens attached to the same lead/Person.
    const editedRecipientSuppression = await createSuppression(
      db,
      {
        workspaceId: WORKSPACE,
        channel: 'email',
        email: 'new@example.net',
        reason: 'Edited address requested opt-out',
        source: 'test_opt_out'
      },
      NOW
    );
    expect(await recordCampaignEmailTrackingOpen(db, token, NOW)).toBe(false);
    expect(await recordCampaignEmailTrackingClick(db, token, linkToken, NOW)).toBe(
      'https://example.com/recipient-resource'
    );
    expect(await eventCount()).toBe(0);
    await liftSuppression(
      db,
      { workspaceId: WORKSPACE, suppressionId: editedRecipientSuppression.id, actorType: 'system' },
      NOW
    );

    // Race regression: the opt-out transaction has acquired the suppression
    // serialization lock but has not committed. An open or click arriving now
    // must wait and recheck *after* the suppression commits, not record an
    // event based on the earlier visible state.
    let unlock!: () => void;
    let hasLock!: () => void;
    const lockReady = new Promise<void>((resolve) => {
      hasLock = resolve;
    });
    const unlocked = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const optOut = db.transaction(async (tx) =>
      withSuppressionBoundary(tx, WORKSPACE, async (held) => {
        hasLock();
        await unlocked;
        return createSuppression(
          held,
          {
            workspaceId: WORKSPACE,
            channel: 'email',
            email: 'maya@example.com',
            reason: 'Late unsubscribe during telemetry',
            source: 'racing_opt_out'
          },
          NOW
        );
      })
    );
    await lockReady;
    const racingOpen = recordCampaignEmailTrackingOpen(db, token, NOW);
    const racingClick = recordCampaignEmailTrackingClick(db, token, linkToken, NOW);
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      expect(await eventCount()).toBe(0);
    } finally {
      unlock();
    }
    const racedSuppression = await optOut;
    expect(await racingOpen).toBe(false);
    expect(await racingClick).toBe('https://example.com/recipient-resource');
    expect(await eventCount()).toBe(0);
    await liftSuppression(
      db,
      {
        workspaceId: WORKSPACE,
        suppressionId: racedSuppression.id,
        actorType: 'system'
      },
      NOW
    );

    // A Never Contact exclusion arriving during telemetry must serialize the
    // same way as canonical email suppression. This transaction blocks both
    // public event writes until its new blacklist row and queue cancellations
    // commit together.
    let finishExclusion!: () => void;
    let exclusionLockReady!: () => void;
    const exclusionLocked = new Promise<void>((resolve) => {
      exclusionLockReady = resolve;
    });
    const exclusionRelease = new Promise<void>((resolve) => {
      finishExclusion = resolve;
    });
    const exclusionWrite = db.transaction((tx) =>
      withSuppressionBoundary(tx, WORKSPACE, async (held) => {
        exclusionLockReady();
        await exclusionRelease;
        return addExclusions(
          held,
          WORKSPACE,
          [{ targetRef: 'https://linkedin.com/in/maya-private-tracking', reason: 'Never contact' }],
          NOW
        );
      })
    );
    await exclusionLocked;
    const openAfterExclusionStarts = recordCampaignEmailTrackingOpen(db, token, NOW);
    const clickAfterExclusionStarts = recordCampaignEmailTrackingClick(db, token, linkToken, NOW);
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      expect(await eventCount()).toBe(0);
    } finally {
      finishExclusion();
    }
    const excluded = await exclusionWrite;
    expect(excluded.added).toBe(1);
    expect(await openAfterExclusionStarts).toBe(false);
    expect(await clickAfterExclusionStarts).toBe('https://example.com/recipient-resource');
    expect(await recordCampaignEmailTrackingOpen(db, token, NOW)).toBe(false);
    expect(await recordCampaignEmailTrackingClick(db, token, linkToken, NOW)).toBe(
      'https://example.com/recipient-resource'
    );
    expect(await eventCount()).toBe(0);
  });

  it('polls past temporary delivery failures so a later reply still stops queued work', async () => {
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

    const temporary = await syncCampaignEmailProviderEvents(db, WORKSPACE, NOW, 50, async () => [
      {
        kind: 'delivery_failure',
        providerEventId: 'gmail:soft-failure',
        occurredAt: '2026-08-20T09:00:15.000Z'
      }
    ]);
    expect(temporary).toMatchObject({ checked: 1, deliveryFailures: 1, replied: 0, failed: 0 });
    expect(
      await findSuppression(db, WORKSPACE, { channel: 'email', email: 'maya@example.com' })
    ).toBeNull();
    const synced = await syncCampaignEmailProviderEvents(
      db,
      WORKSPACE,
      new Date(NOW.getTime() + 11 * 60_000),
      50,
      async () => [
        {
          kind: 'reply',
          providerEventId: 'gmail:reply-1',
          occurredAt: '2026-08-20T09:01:00.000Z'
        }
      ]
    );
    expect(synced).toMatchObject({ checked: 1, replied: 1, bounced: 0, failed: 0 });
    expect((await listCampaignMembers(db, WORKSPACE, campaignId))[0]?.status).toBe('replied');
    expect(
      await db
        .prepare(`SELECT status FROM linkedin_actions WHERE id='lact_after_email_reply'`)
        .get<{ status: string }>()
    ).toEqual({ status: 'skipped' });
  });
});
