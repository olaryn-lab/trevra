import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './db.js';
import {
  DEFAULT_OUTREACH_DAILY_CAP,
  EmailDeliveryBlockedError,
  assertEmailDeliveryCapacity,
  claimEmailDelivery,
  markEmailDeliveryFailure,
  markEmailDeliverySent,
  outreachDailyCap,
  sentOutreachInLastDay
} from './email-deliveries.js';
import { ZOHO_OUTREACH_DAILY_CAP } from './email/zoho-mail.js';

const WORKSPACE = 'ws_email_delivery_test';
let db: Db;

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Delivery test', new Date().toISOString());
});

afterEach(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

const input = (key = 'hash-1') => ({
  workspaceId: WORKSPACE,
  connectionId: null,
  purpose: 'outreach' as const,
  recipient: 'lead@example.test',
  sourceType: 'test_action',
  sourceId: 'action-1',
  idempotencyKey: key
});

describe('shared email delivery claim', () => {
  it('blocks a competing in-flight claim and replays a confirmed send', async () => {
    const first = await claimEmailDelivery(db, input());
    await expect(claimEmailDelivery(db, input())).rejects.toBeInstanceOf(EmailDeliveryBlockedError);

    await markEmailDeliverySent(db, first.delivery.id, {
      provider: 'gmail',
      externalRef: 'gmail-1',
      internetMessageId: '<hash-1@trevra.app>'
    });
    const replay = await claimEmailDelivery(db, input());
    expect(replay.replayed).toBe(true);
    expect(replay.delivery).toMatchObject({
      status: 'sent',
      provider: 'gmail',
      externalRef: 'gmail-1',
      internetMessageId: '<hash-1@trevra.app>',
      attemptCount: 1
    });
  });

  it('makes ambiguous provider outcomes terminal for automatic resend', async () => {
    const first = await claimEmailDelivery(db, input());
    const uncertain = await markEmailDeliveryFailure(
      db,
      first.delivery.id,
      new Error('socket closed')
    );
    expect(uncertain.status).toBe('uncertain');
    await expect(claimEmailDelivery(db, input())).rejects.toThrow(/requires reconciliation/i);
  });

  it('allows an explicit retry after a definite rejection and records the attempt', async () => {
    const first = await claimEmailDelivery(db, input());
    const rejected = await markEmailDeliveryFailure(
      db,
      first.delivery.id,
      new Error('HTTP 400 bad recipient')
    );
    expect(rejected.status).toBe('failed');
    const retry = await claimEmailDelivery(db, input());
    expect(retry).toMatchObject({
      replayed: false,
      delivery: { status: 'sending', attemptCount: 2 }
    });
  });

  it('refuses to mutate one source action onto a different approved payload', async () => {
    const first = await claimEmailDelivery(db, input());
    await markEmailDeliveryFailure(db, first.delivery.id, new Error('HTTP 400 rejected'));
    await expect(claimEmailDelivery(db, input('different-hash'))).rejects.toThrow(
      /different approved payload/i
    );
  });

  it('enforces the configured outreach cap while never consuming it for replies', async () => {
    const now = new Date();
    await db
      .prepare(
        `
      INSERT INTO connections (
        id,workspace_id,provider,provider_config_key,external_connection_id,status,is_demo,created_at,updated_at
      ) VALUES ('conn_cap',?,'gmail','trevra-gmail','cap-mailbox','connected',0,?,?)
    `
      )
      .run(WORKSPACE, now.toISOString(), now.toISOString());
    await db
      .prepare(
        `
      INSERT INTO linkedin_campaign_mailbox_settings (
        workspace_id,connection_id,daily_limit,timezone,working_days_json,work_start_minute,work_end_minute,created_at,updated_at
      ) VALUES (?, 'conn_cap',1,'UTC','[0,1,2,3,4,5,6]'::jsonb,0,1440,?,?)
    `
      )
      .run(WORKSPACE, now.toISOString(), now.toISOString());
    const first = await claimEmailDelivery(db, {
      ...input('cap-1'),
      connectionId: 'conn_cap',
      sourceId: 'cap-action-1'
    });
    await markEmailDeliverySent(
      db,
      first.delivery.id,
      { provider: 'gmail', externalRef: 'g-cap-1' },
      now
    );

    await expect(
      assertEmailDeliveryCapacity(
        db,
        {
          workspaceId: WORKSPACE,
          connectionId: 'conn_cap',
          purpose: 'outreach'
        },
        now
      )
    ).rejects.toThrow(/daily cap reached/i);
    await expect(
      assertEmailDeliveryCapacity(
        db,
        {
          workspaceId: WORKSPACE,
          connectionId: 'conn_cap',
          purpose: 'reply'
        },
        now
      )
    ).resolves.toBeUndefined();
  });

  async function zohoMailbox(dailyLimit: number | null): Promise<void> {
    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO connections
           (id,workspace_id,provider,provider_config_key,external_connection_id,status,is_demo,created_at,updated_at)
           VALUES ('conn_zoho_cap',?,'zoho-mail','trevra-zoho-mail','zoho-cap-mailbox','connected',0,?,?)`
      )
      .run(WORKSPACE, now, now);
    if (dailyLimit !== null) {
      await db
        .prepare(
          `INSERT INTO linkedin_campaign_mailbox_settings
             (workspace_id,connection_id,daily_limit,timezone,working_days_json,work_start_minute,work_end_minute,created_at,updated_at)
             VALUES (?,'conn_zoho_cap',?,'UTC','[0,1,2,3,4,5,6]'::jsonb,0,1440,?,?)`
        )
        .run(WORKSPACE, dailyLimit, now, now);
    }
  }

  async function seedSent(count: number, sentAt: Date): Promise<void> {
    await db
      .prepare(
        `INSERT INTO gtm_deliveries
           (id,workspace_id,channel,connection_id,purpose,recipient,source_type,source_id,idempotency_key,
            status,provider,external_ref,started_at,sent_at)
           SELECT 'gdel_zoho_cap_' || n, ?, 'email', 'conn_zoho_cap', 'outreach',
                  'seed' || n || '@prospect.test', 'test', 'zoho-cap-' || n, 'zoho-cap-' || n,
                  'sent', 'zoho-mail', 'zoho-' || n, ?::timestamptz, ?::timestamptz
           FROM generate_series(1, ?::int) AS n`
      )
      .run(WORKSPACE, sentAt.toISOString(), sentAt.toISOString(), count);
  }

  async function seedInFlight(status: 'sending' | 'uncertain', startedAt: Date): Promise<void> {
    await db
      .prepare(
        `INSERT INTO gtm_deliveries
           (id,workspace_id,channel,connection_id,purpose,recipient,source_type,source_id,idempotency_key,
            status,provider,started_at)
           VALUES ('gdel_zoho_cap_other',?,'email','conn_zoho_cap','outreach','other@prospect.test','test',
                   'zoho-cap-other','zoho-cap-other',?,'zoho-mail',?::timestamptz)`
      )
      .run(WORKSPACE, status, startedAt.toISOString());
  }

  const zohoCapacity = {
    workspaceId: WORKSPACE,
    connectionId: 'conn_zoho_cap',
    purpose: 'outreach' as const
  };

  it('caps a Zoho mailbox at the Zoho ceiling even when the operator allows more', async () => {
    const now = new Date();
    await zohoMailbox(200);
    expect(
      await outreachDailyCap(db, { workspaceId: WORKSPACE, connectionId: 'conn_zoho_cap' })
    ).toBe(ZOHO_OUTREACH_DAILY_CAP);
    await seedSent(ZOHO_OUTREACH_DAILY_CAP - 1, now);
    await expect(assertEmailDeliveryCapacity(db, zohoCapacity, now)).resolves.toBeUndefined();
    await db
      .prepare(
        `INSERT INTO gtm_deliveries
           (id,workspace_id,channel,connection_id,purpose,recipient,source_type,source_id,idempotency_key,
            status,provider,external_ref,started_at,sent_at)
           VALUES ('gdel_zoho_cap_last',?,'email','conn_zoho_cap','outreach','last@prospect.test','test',
                   'zoho-cap-last','zoho-cap-last','sent','zoho-mail','zoho-last',?::timestamptz,?::timestamptz)`
      )
      .run(WORKSPACE, now.toISOString(), now.toISOString());
    expect(
      await sentOutreachInLastDay(
        db,
        { workspaceId: WORKSPACE, connectionId: 'conn_zoho_cap' },
        now
      )
    ).toBe(ZOHO_OUTREACH_DAILY_CAP);
    await expect(assertEmailDeliveryCapacity(db, zohoCapacity, now)).rejects.toThrow(
      `Outbound email daily cap reached for this mailbox (${ZOHO_OUTREACH_DAILY_CAP}); no provider call was attempted.`
    );
    // Replies never consume or hit the outreach cap.
    await expect(
      assertEmailDeliveryCapacity(db, { ...zohoCapacity, purpose: 'reply' }, now)
    ).resolves.toBeUndefined();
  });

  it('lets the operator set a Zoho mailbox lower than the Zoho ceiling, and frees it after a day', async () => {
    const now = new Date();
    await zohoMailbox(5);
    expect(
      await outreachDailyCap(db, { workspaceId: WORKSPACE, connectionId: 'conn_zoho_cap' })
    ).toBe(5);
    await seedSent(5, new Date(now.getTime() - 86_400_000 - 60_000));
    expect(
      await sentOutreachInLastDay(
        db,
        { workspaceId: WORKSPACE, connectionId: 'conn_zoho_cap' },
        now
      )
    ).toBe(0);
    await expect(assertEmailDeliveryCapacity(db, zohoCapacity, now)).resolves.toBeUndefined();
  });

  it('applies no Zoho ceiling to a Gmail mailbox, only the operator limit clamped to 500', async () => {
    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO connections
           (id,workspace_id,provider,provider_config_key,external_connection_id,status,is_demo,created_at,updated_at)
           VALUES ('conn_gmail_cap',?,'gmail','trevra-gmail','gmail-cap-mailbox','connected',0,?,?)`
      )
      .run(WORKSPACE, now, now);
    const setLimit = async (limit: number): Promise<void> => {
      await db
        .prepare(
          `INSERT INTO linkedin_campaign_mailbox_settings
             (workspace_id,connection_id,daily_limit,timezone,working_days_json,work_start_minute,work_end_minute,created_at,updated_at)
             VALUES (?,'conn_gmail_cap',?,'UTC','[0,1,2,3,4,5,6]'::jsonb,0,1440,?,?)
             ON CONFLICT (workspace_id,connection_id) DO UPDATE SET daily_limit=EXCLUDED.daily_limit`
        )
        .run(WORKSPACE, limit, now, now);
    };
    const scope = { workspaceId: WORKSPACE, connectionId: 'conn_gmail_cap' };
    await setLimit(200);
    expect(await outreachDailyCap(db, scope)).toBe(200);
    await setLimit(900);
    expect(await outreachDailyCap(db, scope)).toBe(500);
  });

  it('keeps the default cap for a mailbox with no setting', async () => {
    expect(await outreachDailyCap(db, { workspaceId: WORKSPACE, connectionId: null })).toBe(
      DEFAULT_OUTREACH_DAILY_CAP
    );
    expect(DEFAULT_OUTREACH_DAILY_CAP).toBe(50);
  });

  it('counts another in-flight claim so concurrent sends cannot overshoot the cap', async () => {
    const now = new Date();
    await zohoMailbox(null);
    await seedSent(ZOHO_OUTREACH_DAILY_CAP - 1, now);
    await seedInFlight('sending', now);
    await expect(assertEmailDeliveryCapacity(db, zohoCapacity, now)).rejects.toThrow(
      /daily cap reached/i
    );
  });

  it('counts an uncertain delivery, which the provider may have accepted', async () => {
    const now = new Date();
    await zohoMailbox(null);
    await seedSent(ZOHO_OUTREACH_DAILY_CAP - 1, now);
    await seedInFlight('uncertain', now);
    await expect(assertEmailDeliveryCapacity(db, zohoCapacity, now)).rejects.toThrow(
      /daily cap reached/i
    );
  });

  it('does not count the caller own claimed row when excludeDeliveryId is passed', async () => {
    const now = new Date();
    await zohoMailbox(null);
    await seedSent(ZOHO_OUTREACH_DAILY_CAP - 1, now);
    const own = await claimEmailDelivery(
      db,
      {
        ...input('zoho-self'),
        connectionId: 'conn_zoho_cap',
        sourceId: 'zoho-self-action'
      },
      now
    );
    expect(own.delivery.status).toBe('sending');
    await expect(
      assertEmailDeliveryCapacity(db, { ...zohoCapacity, excludeDeliveryId: own.delivery.id }, now)
    ).resolves.toBeUndefined();
    // Without the exclusion the claimed row itself would count and refuse.
    await expect(assertEmailDeliveryCapacity(db, zohoCapacity, now)).rejects.toThrow(
      /daily cap reached/i
    );
  });
});
