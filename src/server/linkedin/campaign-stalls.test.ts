import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../db.js';
import { openDatabase } from '../db.js';

const mocked = vi.hoisted(() => ({
  campaignExecutionState: vi.fn(),
  notifyLinkedInCampaignStalled: vi.fn(async () => true)
}));
vi.mock('./execution-state.js', () => ({
  campaignExecutionState: mocked.campaignExecutionState
}));
vi.mock('../notifications.js', () => ({
  notifyLinkedInCampaignStalled: mocked.notifyLinkedInCampaignStalled
}));
import {
  scanStalledLinkedInCampaigns,
  eligibleStallFromExecution,
  approvedForStallAlert
} from './campaign-stalls.js';

const WORKSPACE = 'ws_linkedin_stall_watch_test';
const CAMPAIGN = 'cmp_linkedin_stall_watch_test';
const NOW = new Date('2030-10-21T12:00:00.000Z');
let db: Db;

async function heartbeat(now: Date): Promise<void> {
  await db
    .prepare('UPDATE linkedin_companion_devices SET last_seen_at=? WHERE workspace_id=?')
    .run(now.toISOString(), WORKSPACE);
}
async function scan(now: Date) {
  await heartbeat(now);
  return scanStalledLinkedInCampaigns(db, { now });
}
async function continuousScan(): Promise<void> {
  for (const offset of [0, 5, 10, 15, 20, 25]) {
    await scan(new Date(NOW.getTime() + offset * 60_000));
  }
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db
    .prepare(
      'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(WORKSPACE, 'Stall monitor tests', NOW.toISOString());
  for (const table of [
    'linkedin_campaign_stall_alerts',
    'linkedin_companion_devices',
    'linkedin_actions',
    'linkedin_campaigns',
    'linkedin_seats'
  ]) {
    await db.prepare(`DELETE FROM ${table} WHERE workspace_id=?`).run(WORKSPACE);
  }
  await db
    .prepare(
      "INSERT INTO linkedin_seats (workspace_id,seat_key,label,posture,timezone) VALUES (?, 'owner', 'Owner', 'steady', 'Europe/Zurich')"
    )
    .run(WORKSPACE);
  await db
    .prepare(
      "INSERT INTO linkedin_campaigns (id,workspace_id,name,status,seat_key) VALUES (?,?,?,'running','owner')"
    )
    .run(CAMPAIGN, WORKSPACE, 'Verified readiness campaign');
  await db
    .prepare(
      "INSERT INTO linkedin_actions (id,workspace_id,seat_key,campaign_id,kind,target_ref,status,planned_for,source) VALUES (?,?,'owner',?,'profile_view',?,'planned',?,'campaign')"
    )
    .run(
      'lact_stall_watch',
      WORKSPACE,
      CAMPAIGN,
      'https://www.linkedin.com/in/approved-demo-test/',
      new Date(NOW.getTime() - 4 * 60 * 60_000).toISOString()
    );
  await db
    .prepare(
      'INSERT INTO linkedin_companion_devices (id,workspace_id,label,token_hash,last_seen_at) VALUES (?,?,?,?,?)'
    )
    .run(
      'lcdev_stall_watch',
      WORKSPACE,
      'test Companion',
      'stallwatchtokenhash',
      NOW.toISOString()
    );
  mocked.campaignExecutionState.mockReset();
  mocked.notifyLinkedInCampaignStalled.mockReset().mockResolvedValue(true);
  mocked.campaignExecutionState.mockResolvedValue({
    seatKey: 'owner',
    dueNow: 1,
    restingUntil: null,
    humanSendNext: false,
    gate: { kind: 'profile_view', allowed: true, check: null, detail: null }
  });
});
afterEach(async () => {
  await db.close();
});

describe('workspace campaign stall monitoring', () => {
  it('observes eligible overdue work for 30 min before sending one owner alert', async () => {
    await continuousScan();
    expect(mocked.notifyLinkedInCampaignStalled).not.toHaveBeenCalled();
    const first = await scan(new Date(NOW.getTime() + 30 * 60_000));
    expect(first.alerted).toBe(1);
    expect(mocked.notifyLinkedInCampaignStalled).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        workspaceId: WORKSPACE,
        campaignId: CAMPAIGN,
        seatKey: 'owner',
        overdueCount: 1
      })
    );
    await scan(new Date(NOW.getTime() + 35 * 60_000));
    expect(mocked.notifyLinkedInCampaignStalled).toHaveBeenCalledTimes(1);
  });

  it('skips ordinary gate restrictions, paused campaigns and offline Companion', async () => {
    mocked.campaignExecutionState.mockResolvedValue({
      seatKey: 'owner',
      dueNow: 1,
      restingUntil: null,
      humanSendNext: false,
      gate: { allowed: false, check: 'business-hours', detail: 'Outside working hours' }
    });
    expect((await scan(NOW)).eligible).toBe(0);
    mocked.campaignExecutionState.mockResolvedValue({
      seatKey: 'owner',
      dueNow: 1,
      restingUntil: null,
      humanSendNext: false,
      gate: { allowed: true }
    });
    await db.prepare("UPDATE linkedin_campaigns SET status='paused' WHERE id=?").run(CAMPAIGN);
    expect((await scan(NOW)).candidates).toBe(0);
    await db.prepare("UPDATE linkedin_campaigns SET status='running' WHERE id=?").run(CAMPAIGN);
    await db
      .prepare('UPDATE linkedin_companion_devices SET revoked_at=? WHERE workspace_id=?')
      .run(NOW.toISOString(), WORKSPACE);
    expect((await scan(NOW)).candidates).toBe(0);
    expect(mocked.notifyLinkedInCampaignStalled).not.toHaveBeenCalled();
  });

  it('requires continuous evidence and restarts observation after worker activity', async () => {
    await scan(NOW);
    await db
      .prepare(
        "INSERT INTO linkedin_batches (id,workspace_id,seat_key,status,started_at) VALUES (?,?,'owner','completed',?)"
      )
      .run('lbatch_stall_watch', WORKSPACE, new Date(NOW.getTime() + 5 * 60_000).toISOString());
    expect((await scan(new Date(NOW.getTime() + 10 * 60_000))).candidates).toBe(0);
    await db.prepare('DELETE FROM linkedin_batches WHERE id=?').run('lbatch_stall_watch');
    expect((await scan(new Date(NOW.getTime() + 30 * 60_000))).alerted).toBe(0);
  });

  it('claims notification atomically across simultaneous worker replicas', async () => {
    await continuousScan();
    const now = new Date(NOW.getTime() + 30 * 60_000);
    await heartbeat(now);
    let release!: () => void;
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const blocked = new Promise<boolean>((resolve) => {
      release = () => resolve(true);
    });
    mocked.notifyLinkedInCampaignStalled.mockImplementationOnce(async () => {
      notifyStarted();
      return blocked;
    });
    const first = scanStalledLinkedInCampaigns(db, { now });
    await started;
    const second = await scanStalledLinkedInCampaigns(db, { now });
    expect(second.alerted).toBe(0);
    expect(mocked.notifyLinkedInCampaignStalled).toHaveBeenCalledTimes(1);
    release();
    expect((await first).alerted).toBe(1);
  });

  it('does not record an email as delivered when there is no SMTP destination', async () => {
    mocked.notifyLinkedInCampaignStalled.mockResolvedValue(false);
    await continuousScan();
    expect((await scan(new Date(NOW.getTime() + 30 * 60_000))).alerted).toBe(0);
    const marker = await db
      .prepare(
        'SELECT last_notified_at,claimed_at FROM linkedin_campaign_stall_alerts WHERE workspace_id=?'
      )
      .get<{ last_notified_at: Date | null; claimed_at: Date | null }>(WORKSPACE);
    expect(marker?.last_notified_at).toBeNull();
    expect(marker?.claimed_at).toBeNull();
    mocked.notifyLinkedInCampaignStalled.mockResolvedValue(true);
    expect((await scan(new Date(NOW.getTime() + 35 * 60_000))).alerted).toBe(1);
  });
});

describe('stall eligibility decision', () => {
  it('does not classify an unapproved or policy-denied action as a worker stall', () => {
    const review = (effect: 'allow' | 'deny' | 'require_approval', approved: boolean) =>
      ({ policy: { effect }, approved }) as Parameters<typeof approvedForStallAlert>[0];
    expect(approvedForStallAlert(null)).toBe(false);
    expect(approvedForStallAlert(review('deny', true))).toBe(false);
    expect(approvedForStallAlert(review('require_approval', false))).toBe(false);
    expect(approvedForStallAlert(review('require_approval', true))).toBe(true);
    expect(approvedForStallAlert(review('allow', false))).toBe(true);
  });

  it('never labels manual sends, cooldowns or an unreadable gate as worker stalls', () => {
    const base = {
      seatKey: 'owner',
      dueNow: 1,
      restingUntil: null,
      humanSendNext: false,
      gate: { allowed: true }
    } as Parameters<typeof eligibleStallFromExecution>[0];
    expect(eligibleStallFromExecution(base, 'owner')).toBe(true);
    expect(eligibleStallFromExecution({ ...base, humanSendNext: true }, 'owner')).toBe(false);
    expect(eligibleStallFromExecution({ ...base, gate: null }, 'owner')).toBe(false);
    expect(eligibleStallFromExecution({ ...base, restingUntil: NOW.toISOString() }, 'owner')).toBe(
      false
    );
    expect(eligibleStallFromExecution(base, 'another-seat')).toBe(false);
  });
});
