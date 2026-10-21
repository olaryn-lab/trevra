import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { id, openDatabase, type Db } from '../db.js';
import { recordAction } from './actions.js';
import {
  approveLinkedInAction,
  linkedinActionPolicyGate,
  listLinkedInActionReviews,
  listLinkedInActionPolicyEvents,
  reviewLinkedInAction
} from './action-policy.js';

const WS = 'ws_linkedin_action_policy_test';
const FOREIGN = 'ws_linkedin_action_policy_foreign';
const NOW = new Date('2026-10-20T09:00:00Z');
let db: Db;
beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  for (const workspace of [WS, FOREIGN]) {
    await db
      .prepare(
        'INSERT INTO workspaces(id,name,created_at) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING'
      )
      .run(workspace, workspace, NOW.toISOString());
    await db.prepare('DELETE FROM linkedin_actions WHERE workspace_id=?').run(workspace);
    await db.prepare('DELETE FROM workspace_policies WHERE workspace_id=?').run(workspace);
  }
});
afterEach(async () => {
  await db?.close();
});
async function queue(
  kind: 'dm' | 'invite' | 'profile_view' = 'dm',
  workspaceId = WS,
  body = 'Original body'
) {
  const written = await recordAction(
    db,
    {
      workspaceId,
      kind,
      targetRef: `https://linkedin.com/in/${id('person')}/`,
      status: 'planned',
      source: 'manual',
      plannedFor: NOW.toISOString()
    },
    NOW
  );
  if (kind !== 'profile_view')
    await db
      .prepare('UPDATE linkedin_actions SET body=? WHERE workspace_id=? AND id=?')
      .run(body, workspaceId, written.id);
  return written.id;
}
async function policy(effect: 'deny' | 'allow', pattern = 'action:linkedin.*') {
  await db
    .prepare(
      `INSERT INTO workspace_policies
      (id,workspace_id,name,priority,action_pattern,effect,conditions_json,enabled,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'{}'::jsonb,TRUE,?::timestamptz,?::timestamptz)`
    )
    .run(
      id('pol'),
      WS,
      `${effect} browser writes`,
      100,
      pattern,
      effect,
      NOW.toISOString(),
      NOW.toISOString()
    );
}
describe('exact LinkedIn action workspace policy', () => {
  it('holds by default, approves only exact bytes, invalidates the grant on mutation', async () => {
    const id = await queue();
    const preview = (await reviewLinkedInAction(db, WS, id))!;
    expect(preview.policy.effect).toBe('require_approval');
    expect(preview.approved).toBe(false);
    expect((await linkedinActionPolicyGate(db, WS, id)).allowed).toBe(false);
    await expect(approveLinkedInAction(db, WS, id, '0'.repeat(64), 'owner', NOW)).rejects.toThrow(
      'changed since review'
    );
    await approveLinkedInAction(db, WS, id, preview.contentHash, 'owner', NOW);
    expect((await linkedinActionPolicyGate(db, WS, id)).allowed).toBe(true);
    await db
      .prepare("UPDATE linkedin_actions SET body='CHANGED' WHERE workspace_id=? AND id=?")
      .run(WS, id);
    expect((await reviewLinkedInAction(db, WS, id))!.approved).toBe(false);
    expect((await linkedinActionPolicyGate(db, WS, id)).allowed).toBe(false);
    const after = (await reviewLinkedInAction(db, WS, id))!;
    await approveLinkedInAction(db, WS, id, after.contentHash, 'owner', NOW);
    expect((await linkedinActionPolicyGate(db, WS, id)).allowed).toBe(true);
    const forged = await linkedinActionPolicyGate(db, WS, id, {
      kind: 'dm',
      seatKey: 'owner',
      targetRef: after.targetRef,
      body: 'Original body'
    });
    expect(forged).toMatchObject({ allowed: false });
    expect(forged.reason).toContain('changed after it was read');
    const events = await listLinkedInActionPolicyEvents(db, WS, id);
    expect(events.map((item) => item.decision).sort()).toEqual(
      ['held', 'approved', 'allowed', 'held', 'approved', 'allowed', 'changed'].sort()
    );
    expect(
      events
        .filter((item) => item.decision === 'approved')
        .every((item) => item.actorId === 'owner')
    ).toBe(true);
  });
  it('denies despite prior approval, but honors explicit standing allow', async () => {
    const actionId = await queue('invite');
    const preview = (await reviewLinkedInAction(db, WS, actionId))!;
    await approveLinkedInAction(db, WS, actionId, preview.contentHash, 'owner', NOW);
    await policy('deny');
    expect((await linkedinActionPolicyGate(db, WS, actionId)).allowed).toBe(false);
    await expect(
      approveLinkedInAction(db, WS, actionId, preview.contentHash, 'owner', NOW)
    ).rejects.toThrow('denies');
    await db.prepare('DELETE FROM workspace_policies WHERE workspace_id=?').run(WS);
    const other = await queue('dm', WS, 'Other');
    await policy('allow', 'action:linkedin.dm');
    expect((await linkedinActionPolicyGate(db, WS, other)).allowed).toBe(true);
    expect((await linkedinActionPolicyGate(db, WS, actionId)).allowed).toBe(true);
  });
  it('allows read-only profile visits by default and scopes reviews to workspace', async () => {
    const visit = await queue('profile_view');
    expect((await linkedinActionPolicyGate(db, WS, visit)).allowed).toBe(true);
    const dm = await queue('dm');
    expect(await reviewLinkedInAction(db, FOREIGN, dm)).toBeNull();
    await expect(
      approveLinkedInAction(db, FOREIGN, dm, '0'.repeat(64), 'other', NOW)
    ).rejects.toThrow('no longer awaiting');
    const reviews = await listLinkedInActionReviews(db, WS);
    expect(reviews.map((row) => row.actionId)).toEqual([dm]);
  });
  it('shows pending items after the first page is approved, not only the oldest 100', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 505; i++) ids.push(await queue('invite'));
    expect((await listLinkedInActionReviews(db, WS)).length).toBe(100);
    const first = await listLinkedInActionReviews(db, WS);
    for (const row of first)
      await approveLinkedInAction(db, WS, row.actionId, row.contentHash, 'owner', NOW);
    const remaining = await listLinkedInActionReviews(db, WS);
    expect(remaining.length).toBe(100);
    expect(
      remaining.every((row) => !first.some((previous) => previous.actionId === row.actionId))
    ).toBe(true);
  });
});
