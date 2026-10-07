import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { listDomainEvents } from '../control-plane/events.js';
import { getToday } from '../today.js';
import { evaluateLinkedInSafety } from './guard.js';
import {
  assertNoWaitingHandoff,
  guardSeatSendModeChange,
  handoffTitle,
  listLinkedInHandoffs,
  presentLinkedInHandoffs,
  resolveLinkedInHandoff
} from './handoff.js';
import { FLAT_DAY_SHAPE } from './pacing.js';
import { upsertSeat } from './seats.js';

const WORKSPACE = 'ws_linkedin_handoff_test';
const OTHER = 'ws_linkedin_handoff_other';
// A Tuesday, 10:00 UTC: inside the default 09:00-17:00 working window.
const NOW = new Date('2026-08-04T10:00:00.000Z');
const SATURDAY = new Date('2026-08-08T10:00:00.000Z');
const LONG_AGO = new Date('2025-01-01T10:00:00.000Z');
let db: Db;

async function plan(
  actionId: string,
  kind: string,
  target: string,
  body: string | null,
  workspaceId = WORKSPACE
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO linkedin_actions (id,workspace_id,seat_key,kind,target_ref,status,planned_for,source,body,created_at)
       VALUES (?,?,'owner',?,?,'planned',?,'export',?,?)`
    )
    .run(
      actionId,
      workspaceId,
      kind,
      target,
      new Date(NOW.getTime() - 60_000).toISOString(),
      body,
      NOW.toISOString()
    );
}

function resolve(actionId: string, resolution: 'sent' | 'skip', workspaceId = WORKSPACE) {
  return resolveLinkedInHandoff(db, { workspaceId, actionId, resolution, actorUserId: null }, NOW);
}

/** What Today does: list at NOW, then stamp what it shows. */
async function presentAtNow(): Promise<string[]> {
  const listed = await listLinkedInHandoffs(db, WORKSPACE, NOW, { dayShape: FLAT_DAY_SHAPE });
  return (await presentLinkedInHandoffs(db, WORKSPACE, listed, NOW)).map(
    (handoff) => handoff.actionId
  );
}

function todayHandoffIds(at: Date): Promise<string[]> {
  return getToday(db, WORKSPACE, at).then((today) =>
    today.needsAttention
      .filter((item) => item.kind === 'linkedin_handoff_waiting')
      .map((item) => String(item.reference?.id))
  );
}

/** The route's transaction: seat lock, guard, then the seat write. */
function switchToAutomatic(at: Date) {
  return db.transaction(async (tx) => {
    await guardSeatSendModeChange(tx, WORKSPACE, 'owner', 'automated', at);
    return upsertSeat(tx, WORKSPACE, { sendMode: 'automated' }, at);
  });
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  for (const workspaceId of [WORKSPACE, OTHER]) {
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(workspaceId, workspaceId, NOW.toISOString());
  }
  await upsertSeat(
    db,
    WORKSPACE,
    { label: 'Founder', timezone: 'UTC', sendMode: 'human' },
    LONG_AGO
  );
});

afterEach(async () => {
  for (const workspaceId of [WORKSPACE, OTHER])
    await db?.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  await db?.close();
});

describe('LinkedIn human-send handoffs', () => {
  it('lists the next gated invite or message for a human-send seat with its approved copy', async () => {
    await plan(
      'lact_handoff_dm',
      'dm',
      'https://www.linkedin.com/in/maya-handoff/',
      'Hi Maya, thanks for connecting.'
    );
    await plan(
      'lact_handoff_view',
      'profile_view',
      'https://www.linkedin.com/in/view-handoff/',
      null
    );

    const handoffs = await listLinkedInHandoffs(db, WORKSPACE, NOW, { dayShape: FLAT_DAY_SHAPE });
    expect(handoffs).toEqual([
      expect.objectContaining({
        actionId: 'lact_handoff_dm',
        kind: 'dm',
        seatKey: 'owner',
        seatLabel: 'Founder',
        copyText: 'Hi Maya, thanks for connecting.',
        targetUrl: 'https://www.linkedin.com/in/maya-handoff/'
      })
    ]);
    expect(handoffTitle('dm', 'Founder')).toBe('Send a LinkedIn message from Founder');
    expect(handoffTitle('invite', 'Founder')).toBe('Send a LinkedIn invite from Founder');
  });

  it('lists nothing for an automated seat', async () => {
    await upsertSeat(db, WORKSPACE, { sendMode: 'automated' }, NOW);
    await plan('lact_handoff_auto', 'dm', 'https://www.linkedin.com/in/auto-handoff/', 'Hello');
    expect(await listLinkedInHandoffs(db, WORKSPACE, NOW, { dayShape: FLAT_DAY_SHAPE })).toEqual(
      []
    );
  });

  it('holds back a handoff the account limits would refuse', async () => {
    await plan('lact_handoff_weekend', 'dm', 'https://www.linkedin.com/in/weekend/', 'Hello');
    expect(
      await listLinkedInHandoffs(db, WORKSPACE, SATURDAY, { dayShape: FLAT_DAY_SHAPE })
    ).toEqual([]);
  });

  it('holds back a handoff whose campaign is paused', async () => {
    await db
      .prepare(
        `INSERT INTO linkedin_lead_contacts
         (id,workspace_id,list_id,first_name,last_name,company,profile_url,dedupe_key,created_at,updated_at)
         VALUES ('licon_handoff_paused',?,NULL,'Pau','Sed','Acme','https://www.linkedin.com/in/paused-handoff/','paused-handoff',?,?)`
      )
      .run(WORKSPACE, NOW.toISOString(), NOW.toISOString());
    await db
      .prepare(
        `INSERT INTO linkedin_campaigns (id,workspace_id,name,status,sequence_json,seat_key,started_at,created_at,updated_at)
         VALUES ('licmp_handoff_paused',?,'Paused campaign','paused',?::jsonb,'owner',?,?,?)`
      )
      .run(
        WORKSPACE,
        JSON.stringify({
          steps: [{ id: 'step-1', action: 'connection_request', config: { message: null } }]
        }),
        NOW.toISOString(),
        NOW.toISOString(),
        NOW.toISOString()
      );
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_members
         (id,workspace_id,campaign_id,contact_id,status,step_index,current_step_id,completed_step_ids,created_at,updated_at)
         VALUES ('limem_handoff_paused',?,'licmp_handoff_paused','licon_handoff_paused','waiting',0,'step-1','[]'::jsonb,?,?)`
      )
      .run(WORKSPACE, NOW.toISOString(), NOW.toISOString());
    await db
      .prepare(
        `INSERT INTO linkedin_actions
         (id,workspace_id,seat_key,kind,target_ref,campaign_id,campaign_member_id,workflow_step_id,status,planned_for,source,replay_scope,created_at)
         VALUES ('lact_handoff_paused',?,'owner','invite','https://www.linkedin.com/in/paused-handoff/','licmp_handoff_paused','limem_handoff_paused','step-1','planned',?,'campaign','limem_handoff_paused:step-1',?)`
      )
      .run(WORKSPACE, new Date(NOW.getTime() - 60_000).toISOString(), NOW.toISOString());
    expect(await listLinkedInHandoffs(db, WORKSPACE, NOW, { dayShape: FLAT_DAY_SHAPE })).toEqual(
      []
    );
  });

  for (const resolution of ['sent', 'skip'] as const) {
    it(`advances the managed campaign member after '${resolution}'`, async () => {
      await db
        .prepare(
          `INSERT INTO linkedin_lead_contacts
           (id,workspace_id,list_id,first_name,last_name,company,profile_url,dedupe_key,created_at,updated_at)
           VALUES ('licon_handoff_adv',?,NULL,'Ad','Vance','Acme','https://www.linkedin.com/in/advance-handoff/','advance-handoff',?,?)`
        )
        .run(WORKSPACE, NOW.toISOString(), NOW.toISOString());
      await db
        .prepare(
          `INSERT INTO linkedin_campaigns (id,workspace_id,name,status,sequence_json,seat_key,started_at,created_at,updated_at)
           VALUES ('licmp_handoff_adv',?,'Advance campaign','running',?::jsonb,'owner',?,?,?)`
        )
        .run(
          WORKSPACE,
          JSON.stringify({
            steps: [
              { id: 'step-1', action: 'connection_request', config: { message: null } },
              { id: 'step-2', action: 'profile_view', config: {} }
            ]
          }),
          NOW.toISOString(),
          NOW.toISOString(),
          NOW.toISOString()
        );
      await db
        .prepare(
          `INSERT INTO linkedin_campaign_members
           (id,workspace_id,campaign_id,contact_id,status,step_index,current_step_id,completed_step_ids,created_at,updated_at)
           VALUES ('limem_handoff_adv',?,'licmp_handoff_adv','licon_handoff_adv','waiting',0,'step-1','[]'::jsonb,?,?)`
        )
        .run(WORKSPACE, NOW.toISOString(), NOW.toISOString());
      await db
        .prepare(
          `INSERT INTO linkedin_actions
           (id,workspace_id,seat_key,kind,target_ref,campaign_id,campaign_member_id,workflow_step_id,status,planned_for,source,replay_scope,created_at)
           VALUES ('lact_handoff_adv',?,'owner','invite','https://www.linkedin.com/in/advance-handoff/','licmp_handoff_adv','limem_handoff_adv','step-1','planned',?,'campaign','limem_handoff_adv:step-1',?)`
        )
        .run(WORKSPACE, new Date(NOW.getTime() - 60_000).toISOString(), NOW.toISOString());

      await resolve('lact_handoff_adv', resolution);

      const member = await db
        .prepare(
          `SELECT status, step_index, current_step_id, completed_step_ids FROM linkedin_campaign_members WHERE id=?`
        )
        .get<{
          status: string;
          step_index: number;
          current_step_id: string | null;
          completed_step_ids: string[];
        }>('limem_handoff_adv');
      expect(member).toMatchObject({
        status: 'waiting',
        step_index: 1,
        current_step_id: 'step-2',
        completed_step_ids: ['step-1']
      });
    });
  }

  it('marks a handoff sent exactly once, and the guard counts it', async () => {
    await plan('lact_handoff_invite', 'invite', 'https://www.linkedin.com/in/jonas-handoff/', null);

    const first = await resolve('lact_handoff_invite', 'sent');
    const second = await resolve('lact_handoff_invite', 'sent');
    expect(first).toEqual({ actionId: 'lact_handoff_invite', status: 'sent' });
    expect(second).toEqual(first);

    const row = await db
      .prepare('SELECT status, recorded_at FROM linkedin_actions WHERE id=?')
      .get<{ status: string; recorded_at: unknown }>('lact_handoff_invite');
    expect(row?.status).toBe('sent');
    expect(row?.recorded_at).not.toBeNull();

    const events = await listDomainEvents(db, WORKSPACE, {
      streamType: 'linkedin_action',
      streamId: 'lact_handoff_invite'
    });
    expect(
      events.filter((event) => event.eventType === 'linkedin.handoff.marked_sent')
    ).toHaveLength(1);

    const verdict = await evaluateLinkedInSafety(
      db,
      {
        workspaceId: WORKSPACE,
        kind: 'invite',
        targetRef: 'https://www.linkedin.com/in/jonas-handoff/',
        plannedFor: NOW.toISOString()
      },
      NOW,
      { dayShape: FLAT_DAY_SHAPE }
    );
    expect(verdict.checks.find((entry) => entry.check === 'duplicate-target')?.passed).toBe(false);
    expect(verdict.checks.find((entry) => entry.check === 'rolling-24h')?.detail).toContain('1 of');
  });

  it('refuses to mark a skipped handoff sent', async () => {
    await plan('lact_handoff_skip', 'dm', 'https://www.linkedin.com/in/skip-handoff/', 'Hello');
    expect(await resolve('lact_handoff_skip', 'skip')).toEqual({
      actionId: 'lact_handoff_skip',
      status: 'skipped'
    });
    await expect(resolve('lact_handoff_skip', 'sent')).rejects.toMatchObject({ status: 409 });
    const row = await db
      .prepare('SELECT status FROM linkedin_actions WHERE id=?')
      .get<{ status: string }>('lact_handoff_skip');
    expect(row?.status).toBe('skipped');
  });

  it('never resolves another workspace action, nor a row on an automated seat', async () => {
    await upsertSeat(db, OTHER, { label: 'Other', timezone: 'UTC', sendMode: 'human' }, LONG_AGO);
    await plan(
      'lact_handoff_other',
      'dm',
      'https://www.linkedin.com/in/other-handoff/',
      'Hello',
      OTHER
    );
    await expect(resolve('lact_handoff_other', 'sent')).rejects.toMatchObject({ status: 404 });

    await upsertSeat(db, WORKSPACE, { sendMode: 'automated' }, NOW);
    await plan('lact_handoff_robot', 'dm', 'https://www.linkedin.com/in/robot-handoff/', 'Hello');
    await expect(resolve('lact_handoff_robot', 'skip')).rejects.toMatchObject({ status: 409 });
  });

  it('still records a hand send after the seat was switched back to automatic', async () => {
    await plan('lact_handoff_flipped', 'dm', 'https://www.linkedin.com/in/flipped/', 'Hello');
    await upsertSeat(db, WORKSPACE, { sendMode: 'automated' }, NOW);
    expect(await resolve('lact_handoff_flipped', 'sent')).toEqual({
      actionId: 'lact_handoff_flipped',
      status: 'sent'
    });
    const row = await db
      .prepare('SELECT status, recorded_at FROM linkedin_actions WHERE id=?')
      .get<{ status: string; recorded_at: unknown }>('lact_handoff_flipped');
    expect(row?.status).toBe('sent');
    expect(row?.recorded_at).not.toBeNull();
  });

  it('records a hand send on a held row', async () => {
    await plan('lact_handoff_held', 'dm', 'https://www.linkedin.com/in/held/', 'Hello');
    await db
      .prepare(`UPDATE linkedin_actions SET status='held' WHERE id=?`)
      .run('lact_handoff_held');
    expect(await resolve('lact_handoff_held', 'sent')).toEqual({
      actionId: 'lact_handoff_held',
      status: 'sent'
    });
  });

  it('refuses to switch a seat back to automatic while a presented handoff is waiting', async () => {
    await expect(assertNoWaitingHandoff(db, WORKSPACE, 'owner', NOW)).resolves.toBeUndefined();
    await plan('lact_handoff_guard', 'dm', 'https://www.linkedin.com/in/guard/', 'Hello');
    expect(await presentAtNow()).toEqual(['lact_handoff_guard']);
    await expect(assertNoWaitingHandoff(db, WORKSPACE, 'owner', NOW)).rejects.toMatchObject({
      status: 409
    });
  });

  it('keeps a presented handoff blocking the switch on a day the gate refuses', async () => {
    await plan('lact_handoff_friday', 'dm', 'https://www.linkedin.com/in/friday/', 'Hello');
    expect(await presentAtNow()).toEqual(['lact_handoff_friday']);

    // Saturday: the gate would refuse this row, yet the founder may already
    // have sent it. The switch is refused and Today still shows the row.
    await expect(switchToAutomatic(SATURDAY)).rejects.toMatchObject({ status: 409 });
    expect(await todayHandoffIds(SATURDAY)).toEqual(['lact_handoff_friday']);
    const seat = await db
      .prepare(`SELECT send_mode FROM linkedin_seats WHERE workspace_id=? AND seat_key='owner'`)
      .get<{ send_mode: string }>(WORKSPACE);
    expect(seat?.send_mode).toBe('human');

    await resolveLinkedInHandoff(
      db,
      {
        workspaceId: WORKSPACE,
        actionId: 'lact_handoff_friday',
        resolution: 'sent',
        actorUserId: null
      },
      SATURDAY
    );
    await expect(switchToAutomatic(SATURDAY)).resolves.toMatchObject({ sendMode: 'automated' });
  });

  it('keeps a presented handoff answerable after a re-pace moved it into the future', async () => {
    await plan('lact_handoff_repaced', 'dm', 'https://www.linkedin.com/in/repaced/', 'Hello');
    expect(await presentAtNow()).toEqual(['lact_handoff_repaced']);
    await db
      .prepare(`UPDATE linkedin_actions SET planned_for=? WHERE id=?`)
      .run(new Date(NOW.getTime() + 3 * 86_400_000).toISOString(), 'lact_handoff_repaced');

    expect(
      (await listLinkedInHandoffs(db, WORKSPACE, NOW, { dayShape: FLAT_DAY_SHAPE })).map(
        (handoff) => handoff.actionId
      )
    ).toEqual(['lact_handoff_repaced']);
    await expect(assertNoWaitingHandoff(db, WORKSPACE, 'owner', NOW)).rejects.toMatchObject({
      status: 409
    });
    expect(await resolve('lact_handoff_repaced', 'skip')).toEqual({
      actionId: 'lact_handoff_repaced',
      status: 'skipped'
    });
    await expect(assertNoWaitingHandoff(db, WORKSPACE, 'owner', NOW)).resolves.toBeUndefined();
  });

  it('lets a due row that was never presented switch to automatic', async () => {
    await plan('lact_handoff_unseen', 'dm', 'https://www.linkedin.com/in/unseen/', 'Hello');
    expect(
      (await listLinkedInHandoffs(db, WORKSPACE, NOW, { dayShape: FLAT_DAY_SHAPE })).map(
        (handoff) => handoff.actionId
      )
    ).toEqual(['lact_handoff_unseen']);
    await expect(switchToAutomatic(NOW)).resolves.toMatchObject({ sendMode: 'automated' });
  });

  it('never stamps or shows a handoff whose seat switched to automatic before the stamp', async () => {
    await plan('lact_handoff_raced', 'dm', 'https://www.linkedin.com/in/raced/', 'Hello');
    const listed = await listLinkedInHandoffs(db, WORKSPACE, NOW, { dayShape: FLAT_DAY_SHAPE });
    expect(listed.map((handoff) => handoff.actionId)).toEqual(['lact_handoff_raced']);

    await switchToAutomatic(NOW);
    expect(await presentLinkedInHandoffs(db, WORKSPACE, listed, NOW)).toEqual([]);
    const row = await db
      .prepare('SELECT handoff_presented_at FROM linkedin_actions WHERE id=?')
      .get<{ handoff_presented_at: unknown }>('lact_handoff_raced');
    expect(row?.handoff_presented_at).toBeNull();
  });

  it('waits for an in-flight switch before stamping, then drops the flipped seat', async () => {
    await plan('lact_handoff_wait', 'dm', 'https://www.linkedin.com/in/wait/', 'Hello');
    const listed = await listLinkedInHandoffs(db, WORKSPACE, NOW, { dayShape: FLAT_DAY_SHAPE });

    let release!: () => void;
    const held = new Promise<void>((resolveHeld) => (release = resolveHeld));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolveLocked) => (locked = resolveLocked));
    const switching = db.transaction(async (tx) => {
      await guardSeatSendModeChange(tx, WORKSPACE, 'owner', 'automated', NOW);
      locked();
      await held;
      return upsertSeat(tx, WORKSPACE, { sendMode: 'automated' }, NOW);
    });
    await lockTaken;
    const presenting = presentLinkedInHandoffs(db, WORKSPACE, listed, NOW);
    release();
    await switching;
    expect(await presenting).toEqual([]);
  });
});
