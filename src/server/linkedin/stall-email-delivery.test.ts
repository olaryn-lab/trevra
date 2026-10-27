import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type Db } from '../db.js';

const mail = vi.hoisted(() => ({
  configured: true,
  send: vi.fn(async (_input: { to: string; subject: string; text: string; html: string }) => {})
}));

// The whole production notification path runs: PostgreSQL durable claim,
// organization/legacy-owner resolution, escaping, and Nodemailer-facing
// payload composition. Only the final network transport is captured. This
// test cannot send a real email, nor call LinkedIn.
vi.mock('../email.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../email.js')>()),
  smtpConfigured: () => mail.configured,
  sendTransactionalEmail: mail.send
}));

import { notifyStalledLinkedInCampaigns, type StalledCampaign } from './stall-monitor.js';

const WORKSPACE = 'ws_linkedin_stall_delivery_test';
const CAMPAIGN = 'licmp_linkedin_stall_delivery_test';
const NOW = new Date('2026-10-27T12:00:00.000Z');
const alert: StalledCampaign = {
  workspaceId: WORKSPACE,
  campaignId: CAMPAIGN,
  campaignName: 'Launch <script>alert("x")</script>',
  seatKey: 'owner',
  oldestDue: '2026-10-27T08:00:00.000Z',
  approvedDue: 3
};
let db: Db;
const find = async () => [alert];

async function run(now = NOW) {
  // Intentionally no injected notifier. This is the real notifier, stopped
  // only at the SMTP transport boundary.
  return notifyStalledLinkedInCampaigns(db, { now, find });
}

async function stamp(): Promise<{ notified: Date | null; claimed: Date | null } | undefined> {
  return db
    .prepare(
      `SELECT last_notified_at AS notified, claimed_at AS claimed
     FROM linkedin_campaign_stall_notifications WHERE workspace_id=? AND campaign_id=?`
    )
    .get<{ notified: Date | null; claimed: Date | null }>(WORKSPACE, CAMPAIGN);
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces(id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Stall test & workspace', NOW.toISOString());
  await db
    .prepare(
      "INSERT INTO linkedin_campaigns(id,workspace_id,name,status,seat_key) VALUES (?,?,?,'running','owner')"
    )
    .run(CAMPAIGN, WORKSPACE, 'Stall email case');
  mail.configured = true;
  mail.send.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db.close();
});

describe('actual LinkedIn stall-to-owner notification delivery path', () => {
  it('resolves a legacy workspace owner, captures escaped email and stamps once', async () => {
    await db
      .prepare('INSERT INTO users(id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
      .run(
        'usr_stall_delivery',
        WORKSPACE,
        'stall-sink@example.test',
        'Test owner',
        NOW.toISOString()
      );

    expect(await run()).toEqual({ detected: 1, notified: 1, failed: 0 });
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(mail.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'stall-sink@example.test',
        subject: 'LinkedIn campaign needs attention in Trevra',
        text: expect.stringContaining('Oldest scheduled action: 2026-10-27T08:00:00.000Z'),
        html: expect.stringContaining('Launch &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;')
      })
    );
    expect(mail.send.mock.calls[0]?.[0].html).not.toContain('<script>');
    expect((await stamp())?.notified).not.toBeNull();
    expect((await stamp())?.claimed).toBeNull();

    expect(await run(new Date(NOW.getTime() + 60_000))).toEqual({
      detected: 1,
      notified: 0,
      failed: 0
    });
    expect(mail.send).toHaveBeenCalledTimes(1);
  });

  it('prefers the Better Auth organization owner over the legacy fallback', async () => {
    await db
      .prepare('INSERT INTO users(id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
      .run(
        'usr_stall_delivery',
        WORKSPACE,
        'old-owner@example.test',
        'Legacy owner',
        NOW.toISOString()
      );
    // The isolated test database is deliberately schema-only (no Better Auth
    // migration). Provide its hosted-owner query response while leaving all
    // other SQL and the actual notification ledger on PostgreSQL.
    const hosted = {
      prepare: (sql: string) =>
        sql.includes('FROM member m JOIN "user" u')
          ? { all: async () => [{ email: 'hosted-owner@example.test', name: 'Hosted owner' }] }
          : db.prepare(sql)
    } as unknown as Db;
    const result = await notifyStalledLinkedInCampaigns(hosted, { now: NOW, find });
    expect(result).toEqual({ detected: 1, notified: 1, failed: 0 });
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(mail.send.mock.calls[0]?.[0].to).toBe('hosted-owner@example.test');
  });

  it('does not swallow unrelated database failures as if a table were absent', async () => {
    await db
      .prepare('INSERT INTO users(id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
      .run(
        'usr_stall_delivery',
        WORKSPACE,
        'old-owner@example.test',
        'Legacy owner',
        NOW.toISOString()
      );
    const broken = {
      prepare: (sql: string) =>
        sql.includes('FROM member m JOIN "user" u')
          ? {
              all: async () => {
                throw Object.assign(new Error('database query timed out'), { code: '57014' });
              }
            }
          : db.prepare(sql)
    } as unknown as Db;
    expect(await notifyStalledLinkedInCampaigns(broken, { now: NOW, find })).toEqual({
      detected: 1,
      notified: 0,
      failed: 1
    });
    expect(mail.send).not.toHaveBeenCalled();
    expect((await stamp())?.notified).toBeNull();
    expect((await stamp())?.claimed).toBeNull();
  });

  it('does not claim delivery without a configured SMTP transport', async () => {
    await db
      .prepare('INSERT INTO users(id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
      .run(
        'usr_stall_delivery',
        WORKSPACE,
        'stall-sink@example.test',
        'Test owner',
        NOW.toISOString()
      );
    mail.configured = false;
    expect(await run()).toEqual({ detected: 1, notified: 0, failed: 0 });
    expect(mail.send).not.toHaveBeenCalled();
    expect((await stamp())?.notified).toBeNull();
    expect((await stamp())?.claimed).toBeNull();
    mail.configured = true;
    expect(await run(new Date(NOW.getTime() + 60_000))).toMatchObject({ notified: 1 });
  });

  it('does not claim delivery when there is no workspace owner', async () => {
    expect(await run()).toEqual({ detected: 1, notified: 0, failed: 0 });
    expect(mail.send).not.toHaveBeenCalled();
    expect((await stamp())?.notified).toBeNull();
  });

  it('releases its durable claim after SMTP failure and succeeds on retry', async () => {
    await db
      .prepare('INSERT INTO users(id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
      .run(
        'usr_stall_delivery',
        WORKSPACE,
        'stall-sink@example.test',
        'Test owner',
        NOW.toISOString()
      );
    mail.send.mockRejectedValueOnce(new Error('simulated SMTP failure'));
    expect(await run()).toMatchObject({ detected: 1, notified: 0, failed: 1 });
    expect((await stamp())?.notified).toBeNull();
    expect((await stamp())?.claimed).toBeNull();
    expect(await run(new Date(NOW.getTime() + 60_000))).toMatchObject({ notified: 1 });
    expect(mail.send).toHaveBeenCalledTimes(2);
  });
});
