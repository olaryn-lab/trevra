import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { listDomainEvents } from '../control-plane/events.js';
import { evaluateLinkedInSafety } from './guard.js';
import { handoffTitle, listLinkedInHandoffs, resolveLinkedInHandoff } from './handoff.js';
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
        JSON.stringify({ steps: [{ id: 'step-1', action: 'connection_request' }] }),
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
    await expect(resolve('lact_handoff_robot', 'sent')).rejects.toMatchObject({ status: 409 });
  });
});
