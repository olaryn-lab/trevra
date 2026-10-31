import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { openDatabase, type Db } from '../db.js';
import {
  MAX_REPORT_DAYS,
  MAX_TEAM_EXPORT_ROWS,
  RepReportError,
  campaignStatsCsv,
  dailyStatsCsv,
  repReport,
  resolveReportRange,
  teamStatsCsv,
  type RepMetrics,
  type RepReport
} from './rep-reporting.js';
import { registerLinkedInReportRoutes } from './rep-reporting-routes.js';
import { upsertSeat } from './seats.js';

/**
 * Per-rep reporting and the stats exports, against a real PostgreSQL.
 *
 * Two workspaces share every table so isolation is exercised by the same
 * fixtures that exercise attribution: anything from OTHER that leaks into a
 * WS number shows up as a wrong count, not as a separate assertion that
 * might not have been written.
 */
let db: Db;

const WS = 'ws_rep_reporting_test';
const OTHER = 'ws_rep_reporting_other';
const NOW = new Date('2026-10-20T12:00:00.000Z');
const SEPT = '2026-09-01T00:00:00.000Z';

const OWNER = 'usr_rr_owner';
const OWNER_B = 'usr_rr_owner_b';
const ALICE = 'usr_rr_alice';
const BOB = 'usr_rr_bob';
const CAROL = 'usr_rr_carol';
const MALLORY = 'usr_rr_mallory';

const C_BOB = 'licmp_rr_bob';
const C_NONE = 'licmp_rr_none';
const C_OTHER = 'licmp_rr_other';

const RANGE = { from: '2026-10-01', to: '2026-10-08' } as const;

let seq = 0;

beforeAll(async () => migrateAuthDatabase());
afterAll(async () => closeAuthDatabase());

async function setTimezone(workspaceId: string, timezone: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO workspace_settings (workspace_id,timezone,created_at,updated_at) VALUES (?,?,?,?)
       ON CONFLICT (workspace_id) DO UPDATE SET timezone=excluded.timezone`
    )
    .run(workspaceId, timezone, SEPT, SEPT);
}

/** Trevra's `users` row plus the Better Auth `user` it maps to by email. */
async function addUser(userId: string, home: string, name = userId): Promise<void> {
  const email = `${userId}@rep-reporting.test`;
  await db
    .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
    .run(userId, home, email, name, SEPT);
  await db
    .prepare(
      `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,false,?,?)`
    )
    .run(`au_${userId}`, name, email, SEPT, SEPT);
}

async function join(
  userId: string,
  workspaceId: string,
  role: 'owner' | 'member',
  at: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES (?,?,?,?,?)`
    )
    .run(`mem_${workspaceId}_${userId}`, workspaceId, `au_${userId}`, role, at);
}

async function leave(userId: string, workspaceId: string): Promise<void> {
  await db
    .prepare('DELETE FROM member WHERE "organizationId"=? AND "userId"=?')
    .run(workspaceId, `au_${userId}`);
}

async function seat(workspaceId: string, seatKey: string, ownerUserId: string | null) {
  await upsertSeat(
    db,
    workspaceId,
    { label: seatKey, timezone: 'UTC', ownerUserId },
    new Date(SEPT),
    seatKey
  );
}

async function campaign(
  workspaceId: string,
  id: string,
  name: string,
  ownerUserId: string | null
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO linkedin_campaigns (id,workspace_id,name,status,seat_key,owner_user_id,created_at,updated_at)
       VALUES (?,?,?,'running','owner',?,?,?)`
    )
    .run(id, workspaceId, name, ownerUserId, SEPT, SEPT);
}

interface ActionInput {
  ws?: string;
  seat: string;
  kind: string;
  status: string;
  at: string;
  target?: string;
  campaign?: string | null;
  member?: string | null;
  queuedBy?: string | null;
  approvedBy?: string;
}

async function act(input: ActionInput): Promise<string> {
  seq += 1;
  const id = `lact_rr_${seq}`;
  const ws = input.ws ?? WS;
  await db
    .prepare(
      `INSERT INTO linkedin_actions (id,workspace_id,seat_key,kind,target_ref,status,recorded_at,campaign_id,campaign_member_id,source,queued_by_user_id,replay_scope,created_at)
       VALUES (?,?,?,?,?,?,?::timestamptz,?,?,?,?,?,?::timestamptz)`
    )
    .run(
      id,
      ws,
      input.seat,
      input.kind,
      input.target ?? `https://www.linkedin.com/in/rr-${seq}/`,
      input.status,
      input.at,
      input.campaign ?? null,
      input.member ?? null,
      input.campaign ? 'campaign' : 'manual',
      input.queuedBy ?? null,
      id,
      input.at
    );
  if (input.approvedBy)
    await db
      .prepare(
        `INSERT INTO linkedin_action_approvals (workspace_id,action_id,content_hash,approved_by,approved_at)
         VALUES (?,?,?,?,?::timestamptz)`
      )
      .run(ws, id, 'a'.repeat(64), input.approvedBy, input.at);
  return id;
}

/** A lead contact enrolled in a campaign, so email and LinkedIn can share its key. */
async function lead(
  workspaceId: string,
  campaignId: string,
  key: string
): Promise<{ contactId: string; memberId: string }> {
  const contactId = `licon_rr_${key}`;
  const memberId = `licm_rr_${key}`;
  await db
    .prepare(
      `INSERT INTO linkedin_lead_contacts (id,workspace_id,first_name,last_name,company,email,dedupe_key)
       VALUES (?,?,'Lead',?,'Acme',?,?)`
    )
    .run(contactId, workspaceId, key, `${key}@lead.test`, `rr:${key}`);
  await db
    .prepare(
      `INSERT INTO linkedin_campaign_members (id,workspace_id,campaign_id,contact_id,status) VALUES (?,?,?,?,'active')`
    )
    .run(memberId, workspaceId, campaignId, contactId);
  return { contactId, memberId };
}

async function email(input: {
  ws?: string;
  campaign: string;
  lead: { contactId: string; memberId: string };
  at: string;
  events?: string[];
  approvedBy?: string;
  status?: string;
}): Promise<string> {
  seq += 1;
  const id = `licha_rr_${seq}`;
  const ws = input.ws ?? WS;
  await db
    .prepare(
      `INSERT INTO linkedin_campaign_channel_actions
         (id,workspace_id,campaign_id,member_id,contact_id,workflow_step_id,kind,status,planned_for,payload_json,idempotency_key,completed_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,'email',?,?::timestamptz,'{}'::jsonb,?,?::timestamptz,?::timestamptz,?::timestamptz)`
    )
    .run(
      id,
      ws,
      input.campaign,
      input.lead.memberId,
      input.lead.contactId,
      `step-${id}`,
      input.status ?? 'sent',
      input.at,
      `idem-${id}`,
      input.at,
      input.at,
      input.at
    );
  for (const kind of input.events ?? []) {
    seq += 1;
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_email_events (id,workspace_id,channel_action_id,event_kind,occurred_at)
         VALUES (?,?,?,?,?::timestamptz)`
      )
      .run(`lice_rr_${seq}`, ws, id, kind, input.at);
  }
  if (input.approvedBy)
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_email_approvals (workspace_id,action_id,content_hash,approved_by,approved_at)
         VALUES (?,?,?,?,?::timestamptz)`
      )
      .run(ws, id, 'b'.repeat(64), input.approvedBy, input.at);
  return id;
}

function member(report: RepReport, userId: string | null) {
  const row = report.members.find((entry) => entry.userId === userId);
  if (!row) throw new Error(`no member row for ${String(userId)}`);
  return row;
}

function campaignRow(report: RepReport, campaignId: string | null) {
  const row = report.campaigns.find((entry) => entry.campaignId === campaignId);
  if (!row) throw new Error(`no campaign row for ${String(campaignId)}`);
  return row;
}

/** Minimal RFC 4180 reader, so assertions are about cells rather than about raw text. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += char;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const COUNT_KEYS: ReadonlyArray<keyof RepMetrics> = [
  'invitesSent',
  'invitesAccepted',
  'messagesSent',
  'inmailsSent',
  'emailsSent',
  'emailsBounced',
  'follows',
  'likes',
  'endorsements',
  'profileViews'
];

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  const workspaces = [WS, OTHER];
  await db.prepare('DELETE FROM member WHERE "organizationId" = ANY(?::text[])').run(workspaces);
  await db.prepare('DELETE FROM organization WHERE id = ANY(?::text[])').run(workspaces);
  await db.prepare(`DELETE FROM "user" WHERE id LIKE 'au_usr_rr_%'`).run();
  for (const table of [
    'linkedin_campaign_email_events',
    'linkedin_campaign_email_approvals',
    'linkedin_campaign_channel_actions',
    'linkedin_action_approvals',
    'linkedin_actions',
    'linkedin_campaign_members',
    'linkedin_lead_contacts',
    'linkedin_campaigns',
    'linkedin_seats'
  ])
    await db.prepare(`DELETE FROM ${table} WHERE workspace_id = ANY(?::text[])`).run(workspaces);
  await db.prepare(`DELETE FROM users WHERE id LIKE 'usr_rr_%'`).run();
  for (const workspaceId of workspaces) {
    await db
      .prepare(
        'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
      )
      .run(workspaceId, workspaceId, SEPT);
    await db
      .prepare('INSERT INTO organization (id,name,slug,"createdAt") VALUES (?,?,?,?)')
      .run(workspaceId, workspaceId, workspaceId, SEPT);
    await setTimezone(workspaceId, 'UTC');
  }

  await addUser(OWNER, WS, 'Olivia Owner');
  await addUser(OWNER_B, WS, 'Oscar Co-owner');
  await addUser(ALICE, WS, 'Alice Rep');
  await addUser(BOB, WS, 'Bob Rep');
  await addUser(CAROL, WS, 'Carol Departed');
  await addUser(MALLORY, OTHER, 'Mallory Neighbour');
  await join(OWNER, WS, 'owner', '2026-01-01T00:00:00.000Z');
  await join(OWNER_B, WS, 'owner', '2026-02-01T00:00:00.000Z');
  await join(ALICE, WS, 'member', '2026-03-01T00:00:00.000Z');
  await join(BOB, WS, 'member', '2026-03-02T00:00:00.000Z');
  await join(CAROL, WS, 'member', '2026-03-03T00:00:00.000Z');
  await join(MALLORY, OTHER, 'owner', '2026-01-01T00:00:00.000Z');

  await seat(WS, 'owner', null);
  await seat(WS, 'alice', ALICE);
  await seat(WS, 'bob', BOB);
  await seat(WS, 'carol', CAROL);
  await seat(OTHER, 'alice', MALLORY);
  await seat(OTHER, 'mallory', MALLORY);

  await campaign(WS, C_BOB, 'Bob outbound', BOB);
  await campaign(WS, C_NONE, 'Unowned outbound', null);
  await campaign(OTHER, C_OTHER, 'Neighbour outbound', MALLORY);
});

afterEach(async () => {
  await db?.close();
});

/** The shared attribution fixture: every precedence rule fires once, plus neighbour noise. */
async function attributionFixture(): Promise<void> {
  const t1 = 'https://www.linkedin.com/in/rr-target-one/';
  // Rule 2 beats rule 3: Alice's seat, Bob's campaign.
  await act({
    seat: 'alice',
    kind: 'invite',
    status: 'accepted',
    at: '2026-10-02T10:00:00Z',
    target: t1,
    campaign: C_BOB
  });
  // Rule 1 beats rule 2: Bob queued it on Alice's seat.
  await act({
    seat: 'alice',
    kind: 'dm',
    status: 'replied',
    at: '2026-10-03T10:00:00Z',
    target: t1,
    queuedBy: BOB
  });
  // Rule 3: unowned seat, Bob's campaign.
  await act({
    seat: 'owner',
    kind: 'invite',
    status: 'sent',
    at: '2026-10-03T11:00:00Z',
    campaign: C_BOB
  });
  // Rule 4: unowned seat, unowned campaign, approved by the second owner.
  await act({
    seat: 'owner',
    kind: 'invite',
    status: 'declined',
    at: '2026-10-04T11:00:00Z',
    campaign: C_NONE,
    approvedBy: OWNER_B
  });
  // Rule 5: nobody else to name -> the earliest owner.
  await act({ seat: 'owner', kind: 'profile_view', status: 'sent', at: '2026-10-05T11:00:00Z' });
  // A departed member: her seat, and a row she queued herself.
  await act({ seat: 'carol', kind: 'follow', status: 'sent', at: '2026-10-05T12:00:00Z' });
  await act({
    seat: 'owner',
    kind: 'like',
    status: 'sent',
    at: '2026-10-06T12:00:00Z',
    queuedBy: CAROL
  });
  await act({ seat: 'bob', kind: 'endorse', status: 'sent', at: '2026-10-06T13:00:00Z' });
  // Email: campaign owner, then approver.
  const k1 = await lead(WS, C_BOB, 'k1');
  const k2 = await lead(WS, C_BOB, 'k2');
  const k3 = await lead(WS, C_NONE, 'k3');
  await email({ campaign: C_BOB, lead: k1, at: '2026-10-04T09:00:00Z', events: ['reply'] });
  await email({ campaign: C_BOB, lead: k2, at: '2026-10-04T09:30:00Z', events: ['bounce'] });
  await email({ campaign: C_NONE, lead: k3, at: '2026-10-05T09:30:00Z', approvedBy: OWNER_B });
  // Not sent: never counted.
  await email({ campaign: C_BOB, lead: k3, at: '2026-10-05T10:30:00Z', status: 'planned' });
  await act({ seat: 'alice', kind: 'invite', status: 'planned', at: '2026-10-02T10:00:00Z' });
  await act({ seat: 'alice', kind: 'invite', status: 'withdrawn', at: '2026-10-02T10:00:00Z' });
  // The neighbour, using the same seat key in its own workspace.
  await act({
    ws: OTHER,
    seat: 'alice',
    kind: 'invite',
    status: 'accepted',
    at: '2026-10-02T10:00:00Z',
    campaign: C_OTHER
  });
  const ko = await lead(OTHER, C_OTHER, 'ko');
  await email({
    ws: OTHER,
    campaign: C_OTHER,
    lead: ko,
    at: '2026-10-04T09:00:00Z',
    events: ['reply']
  });
}

describe('attribution', () => {
  it('credits each action by the documented precedence across seats and members', async () => {
    await attributionFixture();
    const report = await repReport(db, WS, RANGE, NOW);

    expect(member(report, ALICE)).toMatchObject({
      status: 'current',
      invitesSent: 1,
      invitesAccepted: 1,
      acceptanceRate: 1,
      messagesSent: 0
    });
    expect(member(report, BOB)).toMatchObject({
      status: 'current',
      invitesSent: 1,
      invitesAccepted: 0,
      messagesSent: 1,
      endorsements: 1,
      emailsSent: 2,
      emailsBounced: 1,
      messagedLeads: 3,
      replies: 2,
      repliedAfterMessage: 2
    });
    expect(member(report, BOB).replyRate).toBeCloseTo(2 / 3, 10);
    expect(member(report, OWNER_B)).toMatchObject({
      invitesSent: 1,
      invitesAccepted: 0,
      acceptanceRate: 0,
      emailsSent: 1
    });
    expect(member(report, OWNER)).toMatchObject({ profileViews: 1, invitesSent: 0 });
    expect(member(report, CAROL)).toMatchObject({ status: 'current', follows: 1, likes: 1 });
    expect(report.members.some((row) => row.userId === MALLORY)).toBe(false);
    expect(report.members.some((row) => row.status === 'unattributed')).toBe(false);

    // Attribution partitions the facts: every count sums to the total exactly once.
    for (const key of COUNT_KEYS)
      expect(
        report.members.reduce((sum, row) => sum + Number(row[key]), 0),
        key
      ).toBe(report.total[key]);
    expect(report.total).toMatchObject({
      invitesSent: 3,
      invitesAccepted: 1,
      messagesSent: 1,
      emailsSent: 3,
      emailsBounced: 1,
      follows: 1,
      likes: 1,
      endorsements: 1,
      profileViews: 1
    });

    expect(campaignRow(report, C_BOB)).toMatchObject({
      name: 'Bob outbound',
      invitesSent: 2,
      invitesAccepted: 1,
      emailsSent: 2
    });
    expect(campaignRow(report, C_NONE)).toMatchObject({ invitesSent: 1, emailsSent: 1 });
    expect(campaignRow(report, null)).toMatchObject({
      name: null,
      messagesSent: 1,
      profileViews: 1,
      follows: 1,
      likes: 1,
      endorsements: 1
    });
    expect(report.campaigns.some((row) => row.campaignId === C_OTHER)).toBe(false);
  });

  it('narrows by seat and by campaign without changing whose number it is', async () => {
    await attributionFixture();
    const aliceSeat = await repReport(db, WS, { ...RANGE, seatKey: 'alice' }, NOW);
    expect(aliceSeat.filters).toEqual({ seatKey: 'alice', campaignId: null, emailIncluded: false });
    expect(aliceSeat.total).toMatchObject({ invitesSent: 1, messagesSent: 1, emailsSent: 0 });
    expect(member(aliceSeat, ALICE).invitesSent).toBe(1);
    expect(member(aliceSeat, BOB).messagesSent).toBe(1);

    const bobCampaign = await repReport(db, WS, { ...RANGE, campaignId: C_BOB }, NOW);
    expect(bobCampaign.total).toMatchObject({ invitesSent: 2, emailsSent: 2, messagesSent: 0 });
    expect(member(bobCampaign, ALICE).invitesSent).toBe(1);
    expect(member(bobCampaign, BOB)).toMatchObject({ invitesSent: 1, emailsSent: 2 });
  });
});

describe('departed members', () => {
  it("keeps a removed member's history and labels it former", async () => {
    await attributionFixture();
    const before = await repReport(db, WS, RANGE, NOW);
    await leave(CAROL, WS);
    await leave(ALICE, WS);
    const after = await repReport(db, WS, RANGE, NOW);

    for (const userId of [CAROL, ALICE]) {
      const was = member(before, userId);
      const now = member(after, userId);
      expect(was.status).toBe('current');
      expect(now.status).toBe('former');
      expect(now.name).toBe(was.name);
      const { status: _a, ...wasMetrics } = was;
      const { status: _b, ...nowMetrics } = now;
      expect(nowMetrics).toEqual(wasMetrics);
    }
    expect(after.total).toEqual(before.total);

    const team = await teamStatsCsv(db, WS, { ...RANGE, memberIds: [CAROL] }, NOW);
    const rows = parseCsv(team.csv);
    const header = rows[0]!;
    expect(rows).toHaveLength(1 + 7);
    expect(rows.slice(1).every((row) => row[header.indexOf('member_status')] === 'former')).toBe(
      true
    );
    const followsCol = header.indexOf('follows');
    const likesCol = header.indexOf('likes');
    const day = (date: string) => rows.find((row) => row[header.indexOf('date')] === date)!;
    expect(day('2026-10-05')[followsCol]).toBe('1');
    expect(day('2026-10-06')[likesCol]).toBe('1');
  });

  it('names a deleted approver instead of dropping the work', async () => {
    await act({
      seat: 'owner',
      kind: 'invite',
      status: 'sent',
      at: '2026-10-02T10:00:00Z',
      campaign: C_NONE,
      approvedBy: 'usr_rr_ghost'
    });
    const report = await repReport(db, WS, RANGE, NOW);
    expect(member(report, 'usr_rr_ghost')).toMatchObject({
      status: 'former',
      name: 'Deleted account',
      invitesSent: 1
    });
  });
});

describe('range edges', () => {
  it('counts from inclusive and to exclusive, at local midnight in the workspace zone', async () => {
    await setTimezone(WS, 'Europe/Zurich');
    const edges = [
      ['2026-10-09T21:59:59.999Z', false],
      ['2026-10-09T22:00:00.000Z', true],
      ['2026-10-10T21:59:59.999Z', true],
      ['2026-10-10T22:00:00.000Z', true],
      ['2026-10-11T21:59:59.999Z', true],
      ['2026-10-11T22:00:00.000Z', false]
    ] as const;
    for (const [at] of edges)
      await act({ seat: 'owner', kind: 'profile_view', status: 'sent', at });
    const k = await lead(WS, C_NONE, 'edge');
    await email({ campaign: C_NONE, lead: k, at: '2026-10-09T22:00:00.000Z' });
    await email({ campaign: C_NONE, lead: k, at: '2026-10-11T22:00:00.000Z' });

    const report = await repReport(db, WS, { from: '2026-10-10', to: '2026-10-12' }, NOW);
    expect(report.range).toMatchObject({
      from: '2026-10-10',
      to: '2026-10-12',
      days: 2,
      timezone: 'Europe/Zurich',
      startsAt: '2026-10-09T22:00:00.000Z',
      endsAt: '2026-10-11T22:00:00.000Z',
      preset: null
    });
    expect(report.total.profileViews).toBe(edges.filter(([, inside]) => inside).length);
    expect(report.total.emailsSent).toBe(1);
    expect(report.days.map((day) => [day.date, day.profileViews, day.emailsSent])).toEqual([
      ['2026-10-10', 2, 1],
      ['2026-10-11', 2, 0]
    ]);
  });

  it('cuts a DST day at its real length', async () => {
    await setTimezone(WS, 'Europe/Zurich');
    const report = await repReport(db, WS, { from: '2026-10-25', to: '2026-10-26' }, NOW);
    const [day] = report.days;
    expect(new Date(day!.endsAt).getTime() - new Date(day!.startsAt).getTime()).toBe(
      25 * 3_600_000
    );
  });

  it('resolves presets against today in the workspace zone and refuses bad ranges', () => {
    const zone = 'Europe/Zurich';
    expect(resolveReportRange({ preset: 'today' }, zone, NOW)).toMatchObject({
      from: '2026-10-20',
      to: '2026-10-21',
      days: 1
    });
    expect(resolveReportRange({ preset: 'yesterday' }, zone, NOW)).toMatchObject({
      from: '2026-10-19',
      to: '2026-10-20',
      days: 1
    });
    expect(resolveReportRange({ preset: '7d' }, zone, NOW)).toMatchObject({
      from: '2026-10-14',
      to: '2026-10-21',
      days: 7
    });
    expect(resolveReportRange({ preset: '90d' }, zone, NOW).days).toBe(90);
    expect(resolveReportRange({}, zone, NOW)).toMatchObject({ preset: '30d', days: 30 });
    // 23:30 UTC on the 20th is already the 21st in Zurich.
    expect(
      resolveReportRange({ preset: 'today' }, zone, new Date('2026-10-20T23:30:00Z')).from
    ).toBe('2026-10-21');

    for (const bad of [
      { from: '2026-10-10', to: '2026-10-10' },
      { from: '2026-10-10', to: '2026-10-09' },
      { from: '2026-02-30', to: '2026-03-02' },
      { from: '2026-10-10' },
      { preset: '7d' as const, from: '2026-10-01', to: '2026-10-02' }
    ])
      expect(() => resolveReportRange(bad, zone, NOW)).toThrow(RepReportError);
  });
});

describe('rates', () => {
  it('never divides one population by another', async () => {
    // Three people replied to an invite note without ever being messaged; one
    // person was messaged and has not replied. The old ratio was 3/1.
    for (let index = 0; index < 3; index += 1)
      await act({ seat: 'alice', kind: 'invite', status: 'replied', at: '2026-10-02T10:00:00Z' });
    await act({ seat: 'alice', kind: 'dm', status: 'sent', at: '2026-10-02T11:00:00Z' });
    const report = await repReport(db, WS, RANGE, NOW);
    expect(report.total).toMatchObject({
      replies: 3,
      messagedLeads: 1,
      repliedAfterMessage: 0,
      replyRate: 0,
      invitesSent: 3,
      invitesAccepted: 3,
      acceptanceRate: 1
    });
  });

  it('keeps every rate in [0, 1] and every subset inside its population, over random ledgers', async () => {
    let state = 0x2f6b_1d3a;
    const random = () => {
      state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
      return state / 0x1_0000_0000;
    };
    const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
    const kinds = [
      'invite',
      'dm',
      'reply',
      'inmail',
      'follow',
      'like',
      'endorse',
      'profile_view',
      'group_message'
    ];
    const statuses = [
      'sent',
      'accepted',
      'replied',
      'declined',
      'withdrawn',
      'planned',
      'skipped',
      'exported'
    ];
    const targets = Array.from(
      { length: 12 },
      (_, index) => `https://www.linkedin.com/in/rr-pool-${index}/`
    );
    const leads = [];
    for (let index = 0; index < 8; index += 1)
      leads.push(await lead(WS, index % 2 ? C_BOB : C_NONE, `pool${index}`));
    for (let index = 0; index < 220; index += 1) {
      const day = 1 + Math.floor(random() * 7);
      const leadPick = random() < 0.4 ? pick(leads) : null;
      await act({
        seat: pick(['owner', 'alice', 'bob', 'carol']),
        kind: pick(kinds),
        status: pick(statuses),
        at: `2026-10-0${day}T${String(8 + Math.floor(random() * 10)).padStart(2, '0')}:00:00Z`,
        target: pick(targets),
        campaign: leadPick
          ? leads.indexOf(leadPick) % 2
            ? C_BOB
            : C_NONE
          : pick([null, C_BOB, C_NONE]),
        member: leadPick?.memberId ?? null,
        queuedBy: random() < 0.2 ? pick([ALICE, BOB, CAROL]) : null
      });
    }
    for (let index = 0; index < 40; index += 1) {
      const chosen = pick(leads);
      await email({
        campaign: leads.indexOf(chosen) % 2 ? C_BOB : C_NONE,
        lead: chosen,
        at: `2026-10-0${1 + Math.floor(random() * 7)}T07:00:00Z`,
        events: [random() < 0.4 ? 'reply' : null, random() < 0.2 ? 'bounce' : null].filter(
          (value): value is string => value !== null
        )
      });
    }

    const report = await repReport(db, WS, RANGE, NOW);
    const rows: RepMetrics[] = [
      report.total,
      ...report.days,
      ...report.campaigns,
      ...report.members
    ];
    for (const row of rows) {
      expect(row.invitesAccepted).toBeLessThanOrEqual(row.invitesSent);
      expect(row.repliedAfterMessage).toBeLessThanOrEqual(row.messagedLeads);
      expect(row.repliedAfterMessage).toBeLessThanOrEqual(row.replies);
      expect(row.emailsBounced).toBeLessThanOrEqual(row.emailsSent);
      for (const rate of [row.acceptanceRate, row.replyRate])
        if (rate !== null) {
          expect(rate).toBeGreaterThanOrEqual(0);
          expect(rate).toBeLessThanOrEqual(1);
        }
    }
    for (const key of COUNT_KEYS) {
      const total = report.total[key];
      expect(
        report.days.reduce((sum, row) => sum + Number(row[key]), 0),
        `days ${key}`
      ).toBe(total);
      expect(
        report.members.reduce((sum, row) => sum + Number(row[key]), 0),
        `members ${key}`
      ).toBe(total);
      expect(
        report.campaigns.reduce((sum, row) => sum + Number(row[key]), 0),
        `campaigns ${key}`
      ).toBe(total);
    }
    expect(report.total.invitesSent).toBeGreaterThan(0);
    expect(report.total.messagedLeads).toBeGreaterThan(0);
  });
});

describe('channels', () => {
  it('reports an email-only campaign and a LinkedIn-only campaign on their own evidence', async () => {
    const a = await lead(WS, C_NONE, 'mail-a');
    const b = await lead(WS, C_NONE, 'mail-b');
    await email({ campaign: C_NONE, lead: a, at: '2026-10-02T09:00:00Z', events: ['reply'] });
    await email({ campaign: C_NONE, lead: b, at: '2026-10-02T09:05:00Z', events: ['bounce'] });
    await email({ campaign: C_NONE, lead: b, at: '2026-10-03T09:05:00Z', events: ['opened'] });

    const t = 'https://www.linkedin.com/in/rr-li-only/';
    await act({
      seat: 'bob',
      kind: 'invite',
      status: 'accepted',
      at: '2026-10-02T10:00:00Z',
      campaign: C_BOB,
      target: t
    });
    await act({
      seat: 'bob',
      kind: 'dm',
      status: 'sent',
      at: '2026-10-03T10:00:00Z',
      campaign: C_BOB,
      target: t
    });
    await act({
      seat: 'bob',
      kind: 'inmail',
      status: 'replied',
      at: '2026-10-03T11:00:00Z',
      campaign: C_BOB
    });

    const report = await repReport(db, WS, RANGE, NOW);
    expect(campaignRow(report, C_NONE)).toMatchObject({
      invitesSent: 0,
      messagesSent: 0,
      inmailsSent: 0,
      emailsSent: 3,
      emailsBounced: 1,
      messagedLeads: 2,
      replies: 1,
      repliedAfterMessage: 1,
      replyRate: 0.5,
      acceptanceRate: null
    });
    expect(campaignRow(report, C_BOB)).toMatchObject({
      invitesSent: 1,
      invitesAccepted: 1,
      messagesSent: 1,
      inmailsSent: 1,
      emailsSent: 0,
      emailsBounced: 0,
      messagedLeads: 2,
      replies: 1,
      repliedAfterMessage: 1,
      replyRate: 0.5
    });

    // A LinkedIn account sends no email, so filtering by one leaves email out
    // and says so rather than reporting a zero as if it had been counted.
    const seatOnly = await repReport(db, WS, { ...RANGE, seatKey: 'bob' }, NOW);
    expect(seatOnly.filters.emailIncluded).toBe(false);
    expect(seatOnly.total.emailsSent).toBe(0);
    expect(seatOnly.campaigns.some((row) => row.campaignId === C_NONE)).toBe(false);
  });

  it('counts one lead reached on both channels once', async () => {
    const both = await lead(WS, C_BOB, 'both');
    await act({
      seat: 'bob',
      kind: 'dm',
      status: 'replied',
      at: '2026-10-02T10:00:00Z',
      campaign: C_BOB,
      member: both.memberId
    });
    await email({ campaign: C_BOB, lead: both, at: '2026-10-02T11:00:00Z', events: ['reply'] });
    const report = await repReport(db, WS, RANGE, NOW);
    expect(report.total).toMatchObject({
      messagesSent: 1,
      emailsSent: 1,
      messagedLeads: 1,
      replies: 1,
      repliedAfterMessage: 1,
      replyRate: 1
    });
  });
});

describe('CSV exports', () => {
  it('writes one dense row per day with the range in the filename', async () => {
    await attributionFixture();
    const file = await dailyStatsCsv(db, WS, RANGE, NOW);
    expect(file.filename).toBe('trevra-daily-stats_from-2026-10-01_before-2026-10-08.csv');
    const rows = parseCsv(file.csv);
    const header = rows[0]!;
    expect(header.slice(0, 4)).toEqual(['date', 'starts_at', 'ends_at', 'invites_sent']);
    expect(rows.slice(1).map((row) => row[0])).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
      '2026-10-06',
      '2026-10-07'
    ]);
    const col = (name: string) => header.indexOf(name);
    const first = rows[1]!;
    expect(first[col('invites_sent')]).toBe('0');
    // 0 of 0 is not 0%.
    expect(first[col('acceptance_rate')]).toBe('');
    expect(rows[2]![col('acceptance_rate')]).toBe('1.0000');
    const sum = (name: string) =>
      rows.slice(1).reduce((total, row) => total + Number(row[col(name)]), 0);
    expect(sum('invites_sent')).toBe(3);
    expect(sum('emails_sent')).toBe(3);
  });

  it('neutralises formula-looking campaign and member names', async () => {
    const hostile = '=HYPERLINK("http://evil.example","x")';
    await campaign(WS, 'licmp_rr_hostile', hostile, ALICE);
    await db.prepare('UPDATE users SET name=? WHERE id=?').run('@SUM(A1:A9)', ALICE);
    await db.prepare('UPDATE users SET name=? WHERE id=?').run('+cmd|calc', BOB);
    await act({
      seat: 'alice',
      kind: 'invite',
      status: 'sent',
      at: '2026-10-02T10:00:00Z',
      campaign: 'licmp_rr_hostile'
    });

    const campaignFile = await campaignStatsCsv(db, WS, 'licmp_rr_hostile', RANGE, NOW);
    expect(campaignFile).not.toBeNull();
    expect(campaignFile!.filename).toMatch(
      /^trevra-campaign-[A-Za-z0-9._-]+_from-2026-10-01_before-2026-10-08\.csv$/
    );
    expect(campaignFile!.csv).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`);

    const team = await teamStatsCsv(db, WS, { ...RANGE, memberIds: [ALICE, BOB] }, NOW);
    for (const file of [campaignFile!, team]) {
      const cells = parseCsv(file.csv).flat();
      expect(cells.filter((cell) => /^[\s﻿]*[=+\-@]/u.test(cell))).toEqual([]);
    }
    const names = parseCsv(team.csv)
      .slice(1)
      .map((row) => row[1]);
    expect(new Set(names)).toEqual(new Set(["'@SUM(A1:A9)", "'+cmd|calc"]));
  });

  it('exports the team for selected members only, one row per member per day', async () => {
    await attributionFixture();
    const team = await teamStatsCsv(db, WS, { ...RANGE, memberIds: [BOB, ALICE, BOB] }, NOW);
    expect(team.filename).toBe('trevra-team-stats_from-2026-10-01_before-2026-10-08.csv');
    expect(team.rows).toBe(2 * 7);
    const rows = parseCsv(team.csv);
    const header = rows[0]!;
    expect(header.slice(0, 4)).toEqual(['member_id', 'member_name', 'member_status', 'date']);
    expect(new Set(rows.slice(1).map((row) => row[0]))).toEqual(new Set([ALICE, BOB]));
    const bobEmails = rows
      .slice(1)
      .filter((row) => row[0] === BOB)
      .reduce((sum, row) => sum + Number(row[header.indexOf('emails_sent')]), 0);
    expect(bobEmails).toBe(2);
  });
});

describe('caps', () => {
  it('accepts exactly the day cap and refuses one past it', () => {
    const from = '2025-01-01';
    const at = resolveReportRange({ from, to: '2026-01-02' }, 'UTC', NOW);
    expect(at.days).toBe(MAX_REPORT_DAYS);
    let refused: unknown;
    try {
      resolveReportRange({ from, to: '2026-01-03' }, 'UTC', NOW);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(RepReportError);
    expect((refused as RepReportError).status).toBe(400);
    expect((refused as RepReportError).message).toContain('367');
  });

  it('exports exactly the row cap and refuses the next day past it', async () => {
    const ids: string[] = [];
    for (let index = 0; index < 40; index += 1) {
      const userId = `usr_rr_cap_${String(index).padStart(2, '0')}`;
      await addUser(userId, WS);
      await join(userId, WS, 'member', '2026-04-01T00:00:00.000Z');
      ids.push(userId);
    }
    const days = MAX_TEAM_EXPORT_ROWS / ids.length;
    expect(days).toBe(250);
    const from = new Date('2026-01-01T00:00:00.000Z');
    const dayAfter = (count: number) =>
      new Date(from.getTime() + count * 86_400_000).toISOString().slice(0, 10);

    const atCap = await teamStatsCsv(
      db,
      WS,
      { from: '2026-01-01', to: dayAfter(days), memberIds: ids },
      NOW
    );
    expect(atCap.rows).toBe(MAX_TEAM_EXPORT_ROWS);
    expect(parseCsv(atCap.csv)).toHaveLength(MAX_TEAM_EXPORT_ROWS + 1);

    await expect(
      teamStatsCsv(db, WS, { from: '2026-01-01', to: dayAfter(days + 1), memberIds: ids }, NOW)
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('10,040') });
  });
});

describe('workspace isolation', () => {
  it("never reads, filters by or exports another workspace's rows", async () => {
    await attributionFixture();
    const other = await repReport(db, OTHER, RANGE, NOW);
    expect(other.total).toMatchObject({
      invitesSent: 1,
      invitesAccepted: 1,
      emailsSent: 1,
      replies: 1
    });
    expect(other.members.map((row) => row.userId)).toEqual([MALLORY]);

    await expect(repReport(db, WS, { ...RANGE, campaignId: C_OTHER }, NOW)).rejects.toMatchObject({
      status: 404
    });
    await expect(repReport(db, WS, { ...RANGE, seatKey: 'mallory' }, NOW)).rejects.toMatchObject({
      status: 404
    });
    expect(await campaignStatsCsv(db, WS, C_OTHER, RANGE, NOW)).toBeNull();
    await expect(
      teamStatsCsv(db, WS, { ...RANGE, memberIds: [ALICE, MALLORY] }, NOW)
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('routes', () => {
  function app(workspaceId = WS) {
    const server = express();
    server.use((req, _res, next) => {
      (req as express.Request & { auth?: { workspaceId: string } }).auth = { workspaceId };
      next();
    });
    registerLinkedInReportRoutes(server, db);
    return server;
  }

  it('serves the report and the three exports, and refuses past every cap with a 400', async () => {
    await attributionFixture();
    const server = app();

    const report = await request(server).get('/api/linkedin/manager/reports?range=7d').expect(200);
    expect(report.body.range.days).toBe(7);

    const daily = await request(server)
      .get(`/api/linkedin/manager/reports/daily.csv?from=${RANGE.from}&to=${RANGE.to}`)
      .expect(200);
    expect(daily.headers['content-type']).toContain('text/csv');
    expect(daily.headers['content-disposition']).toBe(
      'attachment; filename="trevra-daily-stats_from-2026-10-01_before-2026-10-08.csv"'
    );

    const campaignCsv = await request(server)
      .get(
        `/api/linkedin/manager/reports/campaigns/${C_BOB}/daily.csv?from=${RANGE.from}&to=${RANGE.to}`
      )
      .expect(200);
    expect(campaignCsv.headers['content-disposition']).toContain(
      '_from-2026-10-01_before-2026-10-08.csv'
    );

    const team = await request(server)
      .get(
        `/api/linkedin/manager/reports/team.csv?from=${RANGE.from}&to=${RANGE.to}&memberIds=${ALICE},${BOB}`
      )
      .expect(200);
    expect(parseCsv(team.text)).toHaveLength(1 + 14);

    const tooLong = await request(server)
      .get('/api/linkedin/manager/reports/daily.csv?from=2025-01-01&to=2026-01-03')
      .expect(400);
    expect(tooLong.body.error).toContain('366');
    await request(server)
      .get('/api/linkedin/manager/reports?from=2026-13-01&to=2026-13-02')
      .expect(400);
    await request(server).get('/api/linkedin/manager/reports/team.csv?range=7d').expect(400);
    const tooMany = Array.from({ length: 201 }, (_, index) => `usr_${index}`).join(',');
    await request(server)
      .get(`/api/linkedin/manager/reports/team.csv?range=7d&memberIds=${tooMany}`)
      .expect(400);
    const pastRows = await request(server)
      .get(
        `/api/linkedin/manager/reports/team.csv?from=2025-01-01&to=2026-01-01&memberIds=${[OWNER, OWNER_B, ALICE, BOB, CAROL].join(',')}&memberIds=usr_rr_x1,usr_rr_x2`
      )
      .expect(400);
    expect(pastRows.body.error).toBeTruthy();

    await request(server)
      .get(`/api/linkedin/manager/reports/campaigns/${C_OTHER}/daily.csv?range=7d`)
      .expect(404);
    await request(app(OTHER))
      .get(`/api/linkedin/manager/reports/campaigns/${C_BOB}/daily.csv?range=7d`)
      .expect(404);
  });
});
