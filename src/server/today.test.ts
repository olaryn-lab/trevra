import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './db.js';
import { createAccount } from './accounts/store.js';
import { ensureDefaultAgent } from './agents.js';
import { pauseSeat, upsertSeat } from './linkedin/seats.js';
import { resolveLinkedInHandoff } from './linkedin/handoff.js';
import { getToday } from './today.js';
import { createSuppression } from './suppressions.js';
import { runRecommendationEngine } from './recommendation-engine.js';

const WORKSPACE = 'ws_today_projection_test';
const NOW = new Date('2026-08-21T08:00:00.000Z');
let db: Db;

async function clearWorkspace(workspaceId: string): Promise<void> {
  // inbound_submissions deliberately RESTRICTS deleting its canonical Person;
  // remove the evidence row first in test teardown, then let workspace cascades
  // clean the rest of the fixture graph.
  await db.prepare('DELETE FROM inbound_submissions WHERE workspace_id=?').run(workspaceId);
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await clearWorkspace(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Today Projection', NOW.toISOString());
});

afterEach(async () => {
  if (db) await clearWorkspace(WORKSPACE);
  await db?.close();
});
async function seedRunningCampaignWithDueProfileView(
  now: Date,
  options: { sentEarlier?: boolean } = {}
): Promise<string> {
  const campaignId = options.sentEarlier ? 'lcmp_today_capacity' : 'lcmp_today_clock_wait';
  await upsertSeat(
    db,
    WORKSPACE,
    { label: 'Founder LinkedIn', timezone: 'Europe/Zurich' },
    new Date('2026-01-05T09:00:00.000Z')
  );
  await db
    .prepare(
      `INSERT INTO linkedin_campaigns
       (id,workspace_id,name,status,seat_key,started_at,created_at,updated_at)
       VALUES (?,?,'Capacity campaign','running','owner',?,?,?)`
    )
    .run(
      campaignId,
      WORKSPACE,
      '2026-08-20T08:00:00.000Z',
      '2026-08-20T08:00:00.000Z',
      '2026-08-21T07:00:00.000Z'
    );

  if (options.sentEarlier) {
    await db
      .prepare(
        `INSERT INTO linkedin_actions
         (id,workspace_id,seat_key,kind,target_ref,campaign_id,status,planned_for,recorded_at,
          source,replay_scope,created_at)
         VALUES ('lact_today_capacity_sent',?,'owner','profile_view',
                 'https://www.linkedin.com/in/already-viewed/',?,'sent',NULL,?,'campaign',
                 'capacity:sent','2026-08-21T07:00:00.000Z')`
      )
      .run(WORKSPACE, campaignId, new Date(now.getTime() - 60 * 60 * 1000).toISOString());
  }

  await db
    .prepare(
      `INSERT INTO linkedin_actions
       (id,workspace_id,seat_key,kind,target_ref,campaign_id,status,planned_for,recorded_at,
        source,replay_scope,created_at)
       VALUES (?,?,'owner','profile_view',
               'https://www.linkedin.com/in/due-now/',?,'planned',?,NULL,'campaign',
               'capacity:due',?)`
    )
    .run(
      options.sentEarlier ? 'lact_today_capacity_due' : 'lact_today_clock_due',
      WORKSPACE,
      campaignId,
      now.toISOString(),
      now.toISOString()
    );
  return campaignId;
}

describe('getToday', () => {
  it('projects durable GTM state into deterministic human-attention order', async () => {
    await upsertSeat(
      db,
      WORKSPACE,
      { label: 'Founder LinkedIn', timezone: 'Europe/Zurich' },
      new Date('2026-08-20T08:00:00.000Z')
    );
    await pauseSeat(
      db,
      WORKSPACE,
      'Challenge detected; inspect the account before resuming.',
      new Date('2026-08-21T07:00:00.000Z')
    );

    await db
      .prepare(
        `INSERT INTO linkedin_threads
         (id,workspace_id,seat_key,thread_urn,profile_url,name,last_message_at,unread,snippet,synced_at,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'lith_today_reply',
        WORKSPACE,
        'owner',
        'thread-today-reply',
        'https://www.linkedin.com/in/sarah-chen/',
        'Sarah Chen',
        '2026-08-21T07:10:00.000Z',
        true,
        'Interested — can you send details?',
        '2026-08-21T07:11:00.000Z',
        '2026-08-21T07:11:00.000Z'
      );
    await db
      .prepare(
        `INSERT INTO linkedin_messages
         (id,workspace_id,thread_id,direction,body,sent_at,position,external_ref,created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'limsg_today_reply',
        WORKSPACE,
        'lith_today_reply',
        'in',
        'Interested — can you send details?',
        '2026-08-21T07:10:00.000Z',
        1,
        'msg-today-reply',
        '2026-08-21T07:11:00.000Z'
      );

    await db
      .prepare(
        `INSERT INTO contacts
         (id,workspace_id,name,email,email_normalized,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(
        'con_today_inbound',
        WORKSPACE,
        'Maya Patel',
        'maya@example.com',
        'maya@example.com',
        '2026-08-21T07:20:00.000Z',
        '2026-08-21T07:20:00.000Z'
      );
    await db
      .prepare(
        `INSERT INTO capture_sources
         (id,workspace_id,name,key,kind,status,accepted_count,rejected_count,created_at,updated_at)
         VALUES (?,?,?,?,?,'active',0,0,?,?)`
      )
      .run(
        'cap_today',
        WORKSPACE,
        'Website',
        'website',
        'website',
        '2026-08-21T07:20:00.000Z',
        '2026-08-21T07:20:00.000Z'
      );
    await db
      .prepare(
        `INSERT INTO inbound_submissions
         (id,workspace_id,capture_source_id,contact_id,idempotency_key,kind,person_name,person_email,message,payload_hash,received_at,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'sub_today',
        WORKSPACE,
        'cap_today',
        'con_today_inbound',
        'today-inbound-0001',
        'demo_request',
        'Maya Patel',
        'maya@example.com',
        'Would like a demo next week.',
        'hash-today',
        '2026-08-21T07:20:00.000Z',
        '2026-08-21T07:20:00.000Z'
      );

    const account = await createAccount(
      db,
      WORKSPACE,
      { domain: 'acme.example', name: 'Acme', source: 'manual' },
      new Date('2026-08-20T09:00:00.000Z')
    );
    await db
      .prepare(
        `INSERT INTO account_scores
         (workspace_id,account_id,score,tier,distinct_kinds,newest_signal_at,rationale_json,computed_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        WORKSPACE,
        account.id,
        92,
        'hot',
        2,
        '2026-08-21T07:30:00.000Z',
        '{}',
        '2026-08-21T07:31:00.000Z'
      );

    const today = await getToday(db, WORKSPACE, NOW);

    expect(today.working).toEqual([]);
    expect(today.recentResults).toEqual([]);
    expect(today.needsAttention.map((item) => item.kind)).toEqual([
      'safety_block',
      'verified_reply',
      'inbound_submission',
      'high_priority_account'
    ]);
    expect(today.needsAttention[0]).toMatchObject({
      href: '/setup/workspace',
      detail: 'Challenge detected; inspect the account before resuming.'
    });
    expect(today.needsAttention[1]).toMatchObject({
      href: '/outreach/inbox',
      title: 'Reply from Sarah Chen'
    });
    expect(today.needsAttention[2]).toMatchObject({
      href: '/outreach/inbound',
      reference: { type: 'inbound_submission', id: 'sub_today' }
    });
    expect(today.needsAttention[3]).toMatchObject({
      href: '/research',
      metadata: { score: 92 }
    });
  });

  it('surfaces a due campaign when the worker safety gate hits actionable capacity', async () => {
    const campaignId = await seedRunningCampaignWithDueProfileView(NOW, { sentEarlier: true });

    const today = await getToday(db, WORKSPACE, NOW);

    const capacity = today.needsAttention.find((item) => item.kind === 'capacity_block');
    expect(capacity).toMatchObject({
      priority: 80,
      href: '/outreach',
      reference: { type: 'linkedin_campaign', id: campaignId },
      metadata: {
        check: 'day-over-day-delta',
        channel: 'linkedin',
        actionKind: 'profile_view',
        dueNow: 1,
        seatKey: 'owner'
      }
    });
    expect(capacity?.title).toContain('Capacity campaign');
    expect(capacity?.detail).toContain("today's ceiling is 1");
  });

  it('keeps clock-only LinkedIn waits out of Needs you', async () => {
    const outsideWorkingHours = new Date('2026-08-21T21:00:00.000Z');
    await seedRunningCampaignWithDueProfileView(outsideWorkingHours);

    const today = await getToday(db, WORKSPACE, outsideWorkingHours);

    expect(today.needsAttention.filter((item) => item.kind === 'capacity_block')).toEqual([]);
    expect(today.working).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'campaign_working',
          title: 'Capacity campaign is running'
        })
      ])
    );
  });

  it('projects live GTM work and recent outcomes from durable state', async () => {
    const agent = await ensureDefaultAgent(db, WORKSPACE);
    await db
      .prepare(
        `INSERT INTO agent_runs
         (id,workspace_id,agent_id,trigger,status,goal,step_count,max_steps,started_at)
         VALUES (?,?,?,'schedule','running',?,2,12,?)`
      )
      .run(
        'arun_today_working',
        WORKSPACE,
        agent.id,
        'Research the hottest accounts and prepare the next safe action.',
        '2026-08-21T07:15:00.000Z'
      );

    const personId = 'con_today_result';
    await db
      .prepare(
        `INSERT INTO contacts
         (id,workspace_id,name,email,email_normalized,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(
        personId,
        WORKSPACE,
        'Lea Müller',
        'lea@result.example',
        'lea@result.example',
        '2026-08-20T08:00:00.000Z',
        '2026-08-21T07:50:00.000Z'
      );
    const account = await createAccount(
      db,
      WORKSPACE,
      { domain: 'result.example', name: 'Result AG', source: 'manual' },
      new Date('2026-08-20T08:00:00.000Z')
    );
    await db
      .prepare(
        `INSERT INTO conversations
         (id,workspace_id,person_id,status,last_activity_at,created_at,updated_at)
         VALUES (?,?,?,'open',?,?,?)`
      )
      .run(
        'conv_today_result',
        WORKSPACE,
        personId,
        '2026-08-21T07:50:00.000Z',
        '2026-08-20T08:00:00.000Z',
        '2026-08-21T07:50:00.000Z'
      );
    await db
      .prepare(
        `INSERT INTO conversation_messages
         (id,workspace_id,conversation_id,channel,provider,direction,body,source_type,source_id,
          outcome_kind,verification_status,occurred_at,created_at)
         VALUES (?,?,?,'email','gmail','inbound',?,'gmail_message',?,'reply','verified',?,?)`
      )
      .run(
        'cmsg_today_result',
        WORKSPACE,
        'conv_today_result',
        'Yes, let us talk next week.',
        'gmail-result-1',
        '2026-08-21T07:50:00.000Z',
        '2026-08-21T07:50:00.000Z'
      );
    await db
      .prepare(
        `INSERT INTO conversation_messages
         (id,workspace_id,conversation_id,channel,provider,direction,body,source_type,source_id,
          verification_status,occurred_at,created_at)
         VALUES (?,?,?,'email','gmail','outbound',?,'gmail_message',?,'verified',?,?)`
      )
      .run(
        'cmsg_today_result_followup',
        WORKSPACE,
        'conv_today_result',
        'Great, I will send times.',
        'gmail-result-2',
        '2026-08-21T07:52:00.000Z',
        '2026-08-21T07:52:00.000Z'
      );
    await db
      .prepare(
        `INSERT INTO gtm_deliveries
         (id,workspace_id,channel,purpose,recipient,source_type,source_id,idempotency_key,status,
          provider,external_ref,attempt_count,started_at,sent_at,created_at,updated_at)
         VALUES (?,?,'email','outreach',?,'test','source-1',?,'sent','gmail','gmail-sent-1',1,?,?,?,?)`
      )
      .run(
        'gdel_today_result',
        WORKSPACE,
        'lea@result.example',
        'today-result-delivery-1',
        '2026-08-21T07:39:00.000Z',
        '2026-08-21T07:40:00.000Z',
        '2026-08-21T07:39:00.000Z',
        '2026-08-21T07:40:00.000Z'
      );
    await db
      .prepare(
        `INSERT INTO opportunities
         (id,workspace_id,person_id,account_id,title,stage,created_at,updated_at,closed_at)
         VALUES (?,?,?,?,'Pilot discussion','won',?,?,?)`
      )
      .run(
        'opp_today_result',
        WORKSPACE,
        personId,
        account.id,
        '2026-08-20T08:00:00.000Z',
        '2026-08-21T07:55:00.000Z',
        '2026-08-21T07:55:00.000Z'
      );

    const today = await getToday(db, WORKSPACE, NOW);

    expect(today.working).toHaveLength(1);
    expect(today.working[0]).toMatchObject({
      kind: 'agent_working',
      title: 'GTM Agent is working',
      reference: { type: 'agent_run', id: 'arun_today_working' },
      href: '/ledger/run/arun_today_working',
      metadata: { stepCount: 2, stopping: false }
    });
    expect(today.recentResults.map((item) => item.kind)).toEqual([
      'opportunity_closed',
      'verified_reply_result',
      'delivery_sent'
    ]);
    expect(today.recentResults[0]).toMatchObject({
      title: 'Result AG: won',
      reference: { type: 'opportunity', id: 'opp_today_result' }
    });
    expect(today.recentResults[1]).toMatchObject({
      title: 'Verified reply from Lea Müller',
      href: '/outreach/inbox'
    });
  });

  it('projects upcoming and recently held meetings, never cancelled or distant ones', async () => {
    const account = await createAccount(
      db,
      WORKSPACE,
      { domain: 'meet.example', name: 'Meet AG', source: 'manual' },
      new Date('2026-08-20T09:00:00.000Z')
    );
    await db
      .prepare(
        `INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(
        'con_today_meet',
        WORKSPACE,
        'Nora Meier',
        'nora@meet.example',
        'nora@meet.example',
        '2026-08-20T08:00:00.000Z',
        '2026-08-20T08:00:00.000Z'
      );
    const meeting = (
      id: string,
      status: string,
      startsAt: string,
      endsAt: string,
      accountId: string | null
    ) =>
      db
        .prepare(
          `INSERT INTO meetings
           (id,workspace_id,provider,external_id,status,origin,starts_at,ends_at,person_id,account_id,cancelled_at,created_at,updated_at)
           VALUES (?,?,'calcom',?,?,'booking',?,?,?,?,?,?,?)`
        )
        .run(
          id,
          WORKSPACE,
          id,
          status,
          startsAt,
          endsAt,
          'con_today_meet',
          accountId,
          status === 'cancelled' ? '2026-08-21T07:00:00.000Z' : null,
          '2026-08-20T08:00:00.000Z',
          '2026-08-20T08:00:00.000Z'
        );
    await meeting(
      'mtg_today_soon',
      'scheduled',
      '2026-08-21T11:00:00.000Z',
      '2026-08-21T11:30:00.000Z',
      account.id
    );
    await meeting(
      'mtg_today_far',
      'scheduled',
      '2026-08-24T11:00:00.000Z',
      '2026-08-24T11:30:00.000Z',
      null
    );
    await meeting(
      'mtg_today_cancelled',
      'cancelled',
      '2026-08-21T12:00:00.000Z',
      '2026-08-21T12:30:00.000Z',
      null
    );
    await meeting(
      'mtg_today_held',
      'rescheduled',
      '2026-08-20T10:00:00.000Z',
      '2026-08-20T10:30:00.000Z',
      null
    );
    await meeting(
      'mtg_today_old',
      'scheduled',
      '2026-08-01T10:00:00.000Z',
      '2026-08-01T10:30:00.000Z',
      null
    );

    const today = await getToday(db, WORKSPACE, NOW);

    const upcoming = today.needsAttention.filter((item) => item.kind === 'meeting_upcoming');
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0]).toMatchObject({
      id: 'meeting-upcoming:mtg_today_soon',
      priority: 25,
      title: 'Meeting with Nora Meier (Meet AG)',
      href: '/research',
      observedAt: '2026-08-21T11:00:00.000Z',
      reference: { type: 'meeting', id: 'mtg_today_soon' },
      metadata: { meetingId: 'mtg_today_soon', provider: 'calcom', accountId: account.id }
    });
    expect(upcoming[0].detail).toMatch(/^Starts .+ \(UTC\)\.$/);

    const held = today.recentResults.filter((item) => item.kind === 'meeting_held');
    expect(held.map((item) => item.id)).toEqual(['meeting-held:mtg_today_held']);
    expect(held[0]).toMatchObject({
      priority: 25,
      title: 'Met Nora Meier',
      href: '/outreach/opportunities',
      observedAt: '2026-08-20T10:30:00.000Z'
    });
  });

  it('shows a Cal.com booking that is also on the Google Calendar once, as the booking', async () => {
    const stamp = '2026-08-20T08:00:00.000Z';
    await db
      .prepare(
        `INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run('con_dup', WORKSPACE, 'Dup Person', 'dup@dup.example', 'dup@dup.example', stamp, stamp);
    const insert = db.prepare(
      `INSERT INTO meetings
         (id,workspace_id,provider,external_id,status,origin,starts_at,ends_at,person_id,created_at,updated_at)
         VALUES (?,?,?,?,'scheduled',?,'2026-08-21T11:00:00.000Z','2026-08-21T11:30:00.000Z','con_dup',?,?)`
    );
    // The calendar row sorts first, so keeping the first row would keep the wrong one.
    await insert.run(
      'mtg_dup_a',
      WORKSPACE,
      'google-calendar',
      'evt-dup',
      'calendar',
      stamp,
      stamp
    );
    await insert.run('mtg_dup_b', WORKSPACE, 'calcom', 'bk-dup', 'booking', stamp, stamp);

    const today = await getToday(db, WORKSPACE, NOW);
    const upcoming = today.needsAttention.filter((item) => item.kind === 'meeting_upcoming');
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0]).toMatchObject({
      reference: { type: 'meeting', id: 'mtg_dup_b' },
      metadata: { provider: 'calcom' }
    });
  });

  it('keeps upcoming meetings when many are held, and hides in-progress and foreign ones', async () => {
    const stamp = '2026-08-20T08:00:00.000Z';
    await db
      .prepare(
        `INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run('con_cap', WORKSPACE, 'Cap Person', 'cap@cap.example', 'cap@cap.example', stamp, stamp);
    const insert = db.prepare(
      `INSERT INTO meetings
         (id,workspace_id,provider,external_id,status,origin,starts_at,ends_at,person_id,created_at,updated_at)
         VALUES (?,?,'calcom',?,'scheduled','booking',?,?,?,?,?)`
    );
    for (let i = 0; i < 55; i += 1) {
      const start = new Date(Date.parse('2026-08-15T10:00:00.000Z') + i * 3_600_000);
      const end = new Date(start.getTime() + 1_800_000);
      await insert.run(
        `mtg_cap_held_${i}`,
        WORKSPACE,
        `mtg_cap_held_${i}`,
        start.toISOString(),
        end.toISOString(),
        'con_cap',
        stamp,
        stamp
      );
    }
    await insert.run(
      'mtg_cap_soon',
      WORKSPACE,
      'mtg_cap_soon',
      '2026-08-21T11:00:00.000Z',
      '2026-08-21T11:30:00.000Z',
      'con_cap',
      stamp,
      stamp
    );
    await insert.run(
      'mtg_cap_live',
      WORKSPACE,
      'mtg_cap_live',
      '2026-08-21T07:45:00.000Z',
      '2026-08-21T08:30:00.000Z',
      'con_cap',
      stamp,
      stamp
    );
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run('ws_today_meet_other', 'Other', stamp);
    await db
      .prepare(
        `INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(
        'con_foreign',
        'ws_today_meet_other',
        'Foreign',
        'f@f.example',
        'f@f.example',
        stamp,
        stamp
      );
    await insert.run(
      'mtg_foreign',
      'ws_today_meet_other',
      'mtg_foreign',
      '2026-08-21T12:00:00.000Z',
      '2026-08-21T12:30:00.000Z',
      'con_foreign',
      stamp,
      stamp
    );

    const today = await getToday(db, WORKSPACE, NOW);
    const upcoming = today.needsAttention.filter((item) => item.kind === 'meeting_upcoming');
    expect(upcoming.map((item) => item.id)).toEqual(['meeting-upcoming:mtg_cap_soon']);
    const held = today.recentResults.filter((item) => item.kind === 'meeting_held');
    expect(held).toHaveLength(50);
    expect(held.some((item) => item.id === 'meeting-held:mtg_cap_live')).toBe(false);
    expect(held.some((item) => item.id === 'meeting-held:mtg_foreign')).toBe(false);
  });

  it("surfaces only an Agent's latest failed run and deep-links to its ledger evidence", async () => {
    const agent = await ensureDefaultAgent(db, WORKSPACE);
    for (const [id, startedAt, finishedAt, error] of [
      [
        'arun_today_failed_old',
        '2026-08-21T06:00:00.000Z',
        '2026-08-21T06:05:00.000Z',
        'Old provider failure'
      ],
      [
        'arun_today_failed_latest',
        '2026-08-21T07:00:00.000Z',
        '2026-08-21T07:05:00.000Z',
        'Research source unavailable'
      ]
    ] as const) {
      await db
        .prepare(
          `INSERT INTO agent_runs
           (id,workspace_id,agent_id,trigger,status,goal,step_count,max_steps,error,started_at,finished_at)
           VALUES (?,?,?,'schedule','failed','Research priority accounts',1,12,?,?,?)`
        )
        .run(id, WORKSPACE, agent.id, error, startedAt, finishedAt);
    }

    const failed = await getToday(db, WORKSPACE, NOW);
    expect(failed.needsAttention.filter((item) => item.kind === 'agent_blocked')).toEqual([
      expect.objectContaining({
        title: 'GTM Agent needs attention',
        detail: 'Research source unavailable',
        href: '/ledger/run/arun_today_failed_latest',
        reference: { type: 'agent_run', id: 'arun_today_failed_latest' },
        metadata: expect.objectContaining({ agentId: agent.id })
      })
    ]);

    await db
      .prepare(
        `INSERT INTO agent_runs
         (id,workspace_id,agent_id,trigger,status,goal,step_count,max_steps,summary,started_at,finished_at)
         VALUES ('arun_today_completed_newer',?,?,'schedule','completed',
                 'Research priority accounts',2,12,'Completed',?,?)`
      )
      .run(WORKSPACE, agent.id, '2026-08-21T07:30:00.000Z', '2026-08-21T07:35:00.000Z');

    const recovered = await getToday(db, WORKSPACE, NOW);
    expect(recovered.needsAttention.filter((item) => item.kind === 'agent_blocked')).toEqual([]);
  });

  it('surfaces a latest verified inbound email reply as human attention', async () => {
    await db
      .prepare(
        `INSERT INTO contacts
         (id,workspace_id,name,email,email_normalized,created_at,updated_at)
         VALUES ('con_today_email_attention',?,'Nora Frei','nora@example.com','nora@example.com',?,?)`
      )
      .run(WORKSPACE, '2026-08-21T07:00:00.000Z', '2026-08-21T07:45:00.000Z');
    await db
      .prepare(
        `INSERT INTO conversations
         (id,workspace_id,person_id,status,last_activity_at,created_at,updated_at)
         VALUES ('conv_today_email_attention',?,'con_today_email_attention','open',?,?,?)`
      )
      .run(
        WORKSPACE,
        '2026-08-21T07:45:00.000Z',
        '2026-08-21T07:00:00.000Z',
        '2026-08-21T07:45:00.000Z'
      );
    await db
      .prepare(
        `INSERT INTO conversation_messages
         (id,workspace_id,conversation_id,channel,provider,direction,body,source_type,source_id,
          outcome_kind,verification_status,occurred_at,created_at)
         VALUES ('cmsg_today_email_attention',?,'conv_today_email_attention','email','gmail','inbound',
                 'Can we schedule a call?','gmail_message','gmail-attention-1','reply','verified',
                 '2026-08-21T07:45:00.000Z','2026-08-21T07:45:00.000Z')`
      )
      .run(WORKSPACE);

    const today = await getToday(db, WORKSPACE, NOW);

    expect(today.needsAttention).toEqual([
      expect.objectContaining({
        kind: 'verified_reply',
        title: 'Reply from Nora Frei',
        href: '/outreach/inbox',
        reference: { type: 'conversation_message', id: 'cmsg_today_email_attention' },
        metadata: expect.objectContaining({
          channel: 'email',
          inboundMailbox: false,
          personId: 'con_today_email_attention'
        })
      })
    ]);
    expect(today.recentResults).toEqual([]);
  });

  async function seedMailbox(
    options: { status?: string; workspaceId?: string; provider?: string } = {}
  ) {
    const workspaceId = options.workspaceId ?? WORKSPACE;
    await db
      .prepare(
        `INSERT INTO connections
         (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,
          mailbox_address,created_at,updated_at)
         VALUES (?,?,?,'trevra-gmail',?,NULL,?,0,'founder@acme.test',?,?)`
      )
      .run(
        `conn_today_mail_${workspaceId}`,
        workspaceId,
        options.provider ?? 'gmail',
        `gmail-today-${workspaceId}`,
        options.status ?? 'connected',
        '2026-08-20T08:00:00.000Z',
        '2026-08-20T08:00:00.000Z'
      );
  }

  async function seedCheck(
    status: 'pass' | 'fail',
    outreachRequestedAt: string | null,
    workspaceId = WORKSPACE,
    provider = 'google'
  ) {
    await db
      .prepare(
        `INSERT INTO email_deliverability_checks
         (workspace_id,domain,provider,status,spf_json,dkim_json,dmarc_json,blockers_json,warnings_json,
          checked_at,expires_at,outreach_requested_at)
         VALUES (?,'acme.test',?,?,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,?::jsonb,'[]'::jsonb,
                 ?::timestamptz,?::timestamptz,?::timestamptz)`
      )
      .run(
        workspaceId,
        provider,
        status,
        JSON.stringify(
          status === 'fail'
            ? [
                {
                  code: 'email_dkim_missing',
                  message: 'No DKIM key is published for acme.test at google._domainkey.',
                  actionHref: '/setup/workspace'
                }
              ]
            : []
        ),
        '2026-08-21T07:30:00.000Z',
        '2026-08-21T07:40:00.000Z',
        outreachRequestedAt
      );
  }

  it('surfaces a failing sending domain someone planned outreach from', async () => {
    await seedMailbox();
    await seedCheck('fail', '2026-08-21T07:30:00.000Z');

    const today = await getToday(db, WORKSPACE, NOW);

    expect(today.needsAttention).toEqual([
      {
        id: 'deliverability:acme.test:google',
        kind: 'deliverability_blocked',
        priority: 25,
        title: 'Email from acme.test is blocked',
        detail: 'No DKIM key is published for acme.test at google._domainkey.',
        href: '/setup/workspace',
        observedAt: '2026-08-21T07:30:00.000Z',
        reference: { type: 'email_domain', id: 'acme.test' },
        metadata: { provider: 'google', blockerCodes: ['email_dkim_missing'] }
      }
    ]);
  });

  it('matches the mailbox provider to the failing check provider', async () => {
    await seedMailbox({ provider: 'microsoft' });
    await seedCheck('fail', '2026-08-21T07:30:00.000Z', WORKSPACE, 'google');
    expect(
      (await getToday(db, WORKSPACE, NOW)).needsAttention.filter(
        (item) => item.kind === 'deliverability_blocked'
      )
    ).toEqual([]);

    await db.prepare('DELETE FROM email_deliverability_checks WHERE workspace_id=?').run(WORKSPACE);
    await seedCheck('fail', '2026-08-21T07:30:00.000Z', WORKSPACE, 'microsoft');
    const items = (await getToday(db, WORKSPACE, NOW)).needsAttention.filter(
      (item) => item.kind === 'deliverability_blocked'
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.metadata).toEqual(expect.objectContaining({ provider: 'microsoft' }));
  });

  it('stays quiet about domains nobody is about to send from', async () => {
    await seedMailbox();
    await seedCheck('fail', null);
    expect((await getToday(db, WORKSPACE, NOW)).needsAttention).toEqual([]);

    await db.prepare('DELETE FROM email_deliverability_checks WHERE workspace_id=?').run(WORKSPACE);
    await seedCheck('fail', '2026-07-01T07:30:00.000Z');
    expect((await getToday(db, WORKSPACE, NOW)).needsAttention).toEqual([]);

    await db.prepare('DELETE FROM email_deliverability_checks WHERE workspace_id=?').run(WORKSPACE);
    await seedCheck('pass', '2026-08-21T07:30:00.000Z');
    expect((await getToday(db, WORKSPACE, NOW)).needsAttention).toEqual([]);

    await db.prepare('DELETE FROM email_deliverability_checks WHERE workspace_id=?').run(WORKSPACE);
    await db
      .prepare("UPDATE connections SET status='disconnected' WHERE workspace_id=?")
      .run(WORKSPACE);
    await seedCheck('fail', '2026-08-21T07:30:00.000Z');
    expect((await getToday(db, WORKSPACE, NOW)).needsAttention).toEqual([]);
  });

  it('labels mail read from the inbound mailbox as new email', async () => {
    await db
      .prepare(
        `INSERT INTO contacts
         (id,workspace_id,name,email,email_normalized,created_at,updated_at)
         VALUES ('con_today_inbound_mail',?,'Nora Frei','nora@client.test','nora@client.test',?,?)`
      )
      .run(WORKSPACE, '2026-08-21T07:00:00.000Z', '2026-08-21T07:45:00.000Z');
    await db
      .prepare(
        `INSERT INTO conversations
         (id,workspace_id,person_id,status,last_activity_at,created_at,updated_at)
         VALUES ('conv_today_inbound_mail',?,'con_today_inbound_mail','open',?,?,?)`
      )
      .run(
        WORKSPACE,
        '2026-08-21T07:45:00.000Z',
        '2026-08-21T07:00:00.000Z',
        '2026-08-21T07:45:00.000Z'
      );
    await db
      .prepare(
        `INSERT INTO conversation_messages
         (id,workspace_id,conversation_id,channel,provider,direction,body,source_type,source_id,
          outcome_kind,verification_status,occurred_at,created_at)
         VALUES ('cmsg_today_inbound_mail',?,'conv_today_inbound_mail','email','gmail','inbound',
                 'Saw your note, are you free Thursday?','inbound_mailbox_message','msg_today_inbound',
                 'reply','verified','2026-08-21T07:45:00.000Z','2026-08-21T07:45:00.000Z')`
      )
      .run(WORKSPACE);

    const today = await getToday(db, WORKSPACE, NOW);

    expect(today.needsAttention).toEqual([
      expect.objectContaining({
        kind: 'verified_reply',
        title: 'New email from Nora Frei',
        metadata: expect.objectContaining({ channel: 'email', inboundMailbox: true })
      })
    ]);
  });

  it('asks the founder to review an unthreaded unsubscribe from a known Person', async () => {
    await db
      .prepare(
        `INSERT INTO contacts
         (id,workspace_id,name,email,email_normalized,created_at,updated_at)
         VALUES ('con_today_unsub',?,'Nora Frei','nora@client.test','nora@client.test',?,?)`
      )
      .run(WORKSPACE, '2026-08-21T07:00:00.000Z', '2026-08-21T07:45:00.000Z');
    await db
      .prepare(
        `INSERT INTO conversations
         (id,workspace_id,person_id,status,last_activity_at,created_at,updated_at)
         VALUES ('conv_today_unsub',?,'con_today_unsub','open',?,?,?)`
      )
      .run(
        WORKSPACE,
        '2026-08-21T07:45:00.000Z',
        '2026-08-21T07:00:00.000Z',
        '2026-08-21T07:45:00.000Z'
      );
    await db
      .prepare(
        `INSERT INTO conversation_messages
         (id,workspace_id,conversation_id,channel,provider,direction,body,source_type,source_id,
          outcome_kind,verification_status,occurred_at,created_at)
         VALUES ('cmsg_today_unsub',?,'conv_today_unsub','email','gmail','inbound',
                 'Please remove me from your list','inbound_mailbox_message','msg_today_unsub',
                 'unsubscribe','verified','2026-08-21T07:45:00.000Z','2026-08-21T07:45:00.000Z')`
      )
      .run(WORKSPACE);

    const today = await getToday(db, WORKSPACE, NOW);

    expect(today.needsAttention).toEqual([
      expect.objectContaining({
        id: 'email-reply:cmsg_today_unsub',
        kind: 'verified_reply',
        title: 'Nora Frei may want to unsubscribe',
        detail: expect.stringMatching(/nobody was suppressed.*Please remove me from your list/),
        reference: { type: 'conversation_message', id: 'cmsg_today_unsub' },
        metadata: expect.objectContaining({
          channel: 'email',
          inboundMailbox: true,
          unsubscribeReview: true,
          personId: 'con_today_unsub'
        })
      })
    ]);

    // Once the Person is suppressed there is nothing left to decide.
    await createSuppression(db, {
      workspaceId: WORKSPACE,
      channel: 'email',
      personId: 'con_today_unsub',
      reason: 'Founder confirmed the unsubscribe',
      source: 'test'
    });
    expect((await getToday(db, WORKSPACE, NOW)).needsAttention).toEqual([]);
  });

  it('hands a gated invite on a human-send seat to the founder, and drops it once marked sent', async () => {
    await upsertSeat(
      db,
      WORKSPACE,
      { label: 'Founder LinkedIn', timezone: 'Europe/Zurich', sendMode: 'human' },
      new Date('2026-01-05T09:00:00.000Z')
    );
    await db
      .prepare(
        `INSERT INTO linkedin_actions (id,workspace_id,seat_key,kind,target_ref,status,planned_for,source,body,created_at)
           VALUES ('lact_today_handoff',?,'owner','invite','https://www.linkedin.com/in/today-handoff/','planned',?,'export','Hi, glad to connect.',?)`
      )
      .run(WORKSPACE, '2026-08-21T07:30:00.000Z', '2026-08-21T07:00:00.000Z');

    const today = await getToday(db, WORKSPACE, NOW);
    const handoff = today.needsAttention.find((item) => item.kind === 'linkedin_handoff_waiting');
    expect(handoff).toMatchObject({
      id: 'linkedin_handoff:lact_today_handoff',
      priority: 42,
      title: 'Send a LinkedIn invite from Founder LinkedIn',
      href: '/outreach',
      reference: { type: 'linkedin_action', id: 'lact_today_handoff' },
      metadata: {
        actionId: 'lact_today_handoff',
        actionKind: 'invite',
        seatKey: 'owner',
        copyText: 'Hi, glad to connect.',
        targetUrl: 'https://www.linkedin.com/in/today-handoff/',
        targetRef: 'https://www.linkedin.com/in/today-handoff/',
        channel: 'linkedin'
      }
    });

    await resolveLinkedInHandoff(
      db,
      {
        workspaceId: WORKSPACE,
        actionId: 'lact_today_handoff',
        resolution: 'sent',
        actorUserId: null
      },
      NOW
    );
    const after = await getToday(db, WORKSPACE, NOW);
    expect(after.needsAttention.filter((item) => item.kind === 'linkedin_handoff_waiting')).toEqual(
      []
    );
  });

  it('never leaks another workspace into the projection', async () => {
    const other = 'ws_today_projection_other';
    await clearWorkspace(other);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(other, 'Other', NOW.toISOString());
    await upsertSeat(db, other, { label: 'Other LinkedIn', timezone: 'UTC' }, NOW);
    await pauseSeat(db, other, 'Other workspace pause', NOW);
    await seedMailbox({ workspaceId: other });
    await seedCheck('fail', '2026-08-21T07:30:00.000Z', other);

    const today = await getToday(db, WORKSPACE, NOW);
    expect(today.needsAttention).toEqual([]);

    await clearWorkspace(other);
  });
});

describe('qualified demand in Today', () => {
  it('collapses a first-party inbound plus hot account into one commercial decision', async () => {
    const personId = 'con_today_demand';
    const sourceId = 'cap_today_demand';
    await db
      .prepare(
        `INSERT INTO contacts
         (id,workspace_id,name,email,email_normalized,role,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        personId,
        WORKSPACE,
        'Maya Patel',
        'maya@demand.example',
        'maya@demand.example',
        'VP Growth',
        NOW.toISOString(),
        NOW.toISOString()
      );
    await db
      .prepare(
        `INSERT INTO capture_sources
         (id,workspace_id,name,key,kind,status,accepted_count,rejected_count,created_at,updated_at)
         VALUES (?,?,?,?,?,'active',0,0,?,?)`
      )
      .run(
        sourceId,
        WORKSPACE,
        'Beseam scan',
        'beseam-scan',
        'diagnostic',
        NOW.toISOString(),
        NOW.toISOString()
      );
    const account = await createAccount(
      db,
      WORKSPACE,
      { domain: 'demand-today.example', name: 'Demand Today', source: 'manual' },
      new Date('2026-08-20T09:00:00.000Z')
    );
    await db
      .prepare(
        `INSERT INTO inbound_submissions
         (id,workspace_id,capture_source_id,contact_id,account_id,idempotency_key,kind,
          person_name,person_email,company_domain,company_name,message,page_url,payload_hash,
          received_at,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'sub_today_demand',
        WORKSPACE,
        sourceId,
        personId,
        account.id,
        'today-demand-1',
        'scan_completed',
        'Maya Patel',
        'maya@demand.example',
        'demand-today.example',
        'Demand Today',
        'Ran the diagnostic and requested the report.',
        'https://beseam.example/scan/demand-today',
        'hash-today-demand',
        '2026-08-21T07:20:00.000Z',
        '2026-08-21T07:20:00.000Z'
      );
    await db
      .prepare(
        `INSERT INTO account_scores
         (workspace_id,account_id,score,tier,distinct_kinds,newest_signal_at,rationale_json,computed_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        WORKSPACE,
        account.id,
        94,
        'hot',
        2,
        '2026-08-21T07:10:00.000Z',
        '{}',
        '2026-08-21T07:11:00.000Z'
      );
    for (const [index, kind, detail, url] of [
      [
        0,
        'hiring-up',
        'Hiring increased across growth roles.',
        'https://demand-today.example/careers'
      ],
      [1, 'pricing-changed', 'Enterprise pricing changed.', 'https://demand-today.example/pricing']
    ] as const) {
      await db
        .prepare(
          `INSERT INTO account_signals
           (id,workspace_id,account_id,kind,detail,evidence_url,observed_at,fingerprint,created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`
        )
        .run(
          `sig_today_demand_${index}`,
          WORKSPACE,
          account.id,
          kind,
          detail,
          url,
          `2026-08-21T0${6 + index}:00:00.000Z`,
          `today-demand-${index}`,
          `2026-08-21T0${6 + index}:00:00.000Z`
        );
    }

    await runRecommendationEngine(db, WORKSPACE, NOW);
    const today = await getToday(db, WORKSPACE, NOW);

    expect(today.needsAttention).toHaveLength(1);
    expect(today.needsAttention[0]).toMatchObject({
      kind: 'qualification_decision',
      title: 'Talk to Maya Patel at Demand Today',
      href: '/outreach/inbound',
      reference: { type: 'recommendation' },
      metadata: {
        personId,
        accountId: account.id,
        recommendationType: 'qualified_demand',
        demandOrigin: 'first_party'
      }
    });
  });

  it('routes hot-account demand with one known contact into outbound', async () => {
    const personId = 'con_today_known_contact';
    await db
      .prepare(
        `INSERT INTO contacts
         (id,workspace_id,name,email,email_normalized,role,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        personId,
        WORKSPACE,
        'Sarah Chen',
        'sarah@outbound.example',
        'sarah@outbound.example',
        'VP Engineering',
        NOW.toISOString(),
        NOW.toISOString()
      );
    const account = await createAccount(
      db,
      WORKSPACE,
      { domain: 'outbound-today.example', name: 'Outbound Today', source: 'manual' },
      new Date('2026-08-20T09:00:00.000Z')
    );
    await db
      .prepare(
        `INSERT INTO account_contacts
         (id,workspace_id,account_id,contact_id,role,source,confidence,created_at,updated_at)
         VALUES (?,?,?,?,?,'manual','explicit',?,?)`
      )
      .run(
        'ac_today_known_contact',
        WORKSPACE,
        account.id,
        personId,
        'VP Engineering',
        '2026-08-20T09:00:00.000Z',
        '2026-08-20T09:00:00.000Z'
      );
    await db
      .prepare(
        `INSERT INTO account_scores
         (workspace_id,account_id,score,tier,distinct_kinds,newest_signal_at,rationale_json,computed_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        WORKSPACE,
        account.id,
        92,
        'hot',
        2,
        '2026-08-21T07:10:00.000Z',
        '{}',
        '2026-08-21T07:11:00.000Z'
      );
    for (const [index, kind, detail, url] of [
      [
        0,
        'hiring-up',
        'Added platform engineering roles.',
        'https://outbound-today.example/careers'
      ],
      [1, 'tech-added', 'Added a new infrastructure tool.', 'https://outbound-today.example/']
    ] as const) {
      await db
        .prepare(
          `INSERT INTO account_signals
           (id,workspace_id,account_id,kind,detail,evidence_url,observed_at,fingerprint,created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`
        )
        .run(
          `sig_today_known_${index}`,
          WORKSPACE,
          account.id,
          kind,
          detail,
          url,
          `2026-08-21T0${6 + index}:00:00.000Z`,
          `today-known-${index}`,
          `2026-08-21T0${6 + index}:00:00.000Z`
        );
    }

    await runRecommendationEngine(db, WORKSPACE, NOW, { includeStaleProposals: false });
    const today = await getToday(db, WORKSPACE, NOW);

    expect(today.needsAttention).toHaveLength(1);
    expect(today.needsAttention[0]).toMatchObject({
      kind: 'qualification_decision',
      title: 'Reach out to Sarah Chen at Outbound Today',
      href: '/outreach',
      metadata: {
        personId,
        accountId: account.id,
        demandOrigin: 'known_contact'
      }
    });
  });

  it('routes hot accounts with no known person into a prefilled Find people source', async () => {
    const account = await createAccount(
      db,
      WORKSPACE,
      {
        domain: 'discover-today.example',
        name: 'Discover Today',
        linkedinUrl: 'https://www.linkedin.com/company/discover-today/',
        source: 'manual'
      },
      new Date('2026-08-20T09:00:00.000Z')
    );
    await db
      .prepare(
        `INSERT INTO account_scores
         (workspace_id,account_id,score,tier,distinct_kinds,newest_signal_at,rationale_json,computed_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        WORKSPACE,
        account.id,
        94,
        'hot',
        2,
        '2026-08-21T07:10:00.000Z',
        '{}',
        '2026-08-21T07:11:00.000Z'
      );
    for (const [index, kind, detail, url] of [
      [
        0,
        'hiring-up',
        'Added platform engineering roles.',
        'https://discover-today.example/careers'
      ],
      [
        1,
        'pricing-changed',
        'Changed enterprise pricing.',
        'https://discover-today.example/pricing'
      ]
    ] as const) {
      await db
        .prepare(
          `INSERT INTO account_signals
           (id,workspace_id,account_id,kind,detail,evidence_url,observed_at,fingerprint,created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`
        )
        .run(
          `sig_today_discover_${index}`,
          WORKSPACE,
          account.id,
          kind,
          detail,
          url,
          `2026-08-21T0${6 + index}:00:00.000Z`,
          `today-discover-${index}`,
          `2026-08-21T0${6 + index}:00:00.000Z`
        );
    }

    await runRecommendationEngine(db, WORKSPACE, NOW, { includeStaleProposals: false });
    const today = await getToday(db, WORKSPACE, NOW);

    expect(today.needsAttention).toHaveLength(1);
    expect(today.needsAttention[0]).toMatchObject({
      kind: 'qualification_decision',
      title: 'Find the right person at Discover Today',
      metadata: {
        personId: null,
        accountId: account.id,
        recommendationType: 'person_discovery',
        demandOrigin: 'person_discovery',
        discoveryKind: 'company_employees',
        discoveryUrl: 'https://www.linkedin.com/company/discover-today/people/'
      }
    });
    expect(today.needsAttention[0]?.href).toContain('/outreach?focus=leads');
    const query = new URL(`https://trevra.test${today.needsAttention[0]?.href}`).searchParams;
    expect(query.get('kind')).toBe('company_employees');
    expect(query.get('url')).toBe('https://www.linkedin.com/company/discover-today/people/');
  });
});
