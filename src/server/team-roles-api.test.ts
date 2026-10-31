import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';
import { auth as betterAuth, closeAuthDatabase, migrateAuthDatabase } from './auth-service.js';
import { listDomainEvents } from './control-plane/events.js';
import { openDatabase, id, type Db } from './db.js';
import { reviewLinkedInAction } from './linkedin/action-policy.js';
import { recordAction } from './linkedin/actions.js';
import type { WorkspaceRole } from './roles.js';

/**
 * TRV-045: the manager role, end to end against real PostgreSQL and the real
 * Better Auth organization plugin. Every assertion goes through HTTP, so the
 * capability map (roles.ts), the route guards (app.ts) and the plugin hooks
 * (auth-service.ts) are exercised together.
 */

let db: Db;
let app: ReturnType<typeof createApp>;
let seq = 0;

beforeAll(async () => {
  await migrateAuthDatabase();
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
});
afterAll(async () => {
  await db?.close();
  await closeAuthDatabase();
});

const NOW = new Date('2026-10-31T09:00:00Z');
const HASH_ZERO = '0'.repeat(64);

type Person = Awaited<ReturnType<typeof signUp>>;

function uniqueEmail(label: string) {
  seq += 1;
  return `${label}-${Date.now()}-${seq}@team-roles.test`;
}

async function signUp(label: string) {
  const agent = request.agent(app);
  const email = uniqueEmail(label);
  const res = await agent
    .post('/api/auth/sign-up/email')
    .send({ email, password: 'correct-horse-battery-staple', name: label })
    .expect(200);
  const auth = (await agent.get('/api/auth/session').expect(200)).body.auth as {
    userId: string;
    workspaceId: string;
    role: WorkspaceRole;
  };
  return { agent, email, authUserId: res.body.user.id as string, auth };
}

/** Adds `person` to `workspaceId` with `role` and makes it their active workspace. */
async function join(person: Person, workspaceId: string, role: WorkspaceRole) {
  await betterAuth.api.addMember({
    body: { userId: person.authUserId, organizationId: workspaceId, role }
  });
  await person.agent
    .post('/api/auth/organization/set-active')
    .send({ organizationId: workspaceId })
    .expect(200);
  const auth = (await person.agent.get('/api/auth/session').expect(200)).body.auth;
  expect(auth.role).toBe(role);
  expect(auth.workspaceId).toBe(workspaceId);
  person.auth = auth;
}

async function team() {
  const owner = await signUp('owner');
  const manager = await signUp('manager');
  const member = await signUp('member');
  await join(manager, owner.auth.workspaceId, 'manager');
  await join(member, owner.auth.workspaceId, 'member');
  return { owner, manager, member, workspaceId: owner.auth.workspaceId };
}

async function memberRowId(workspaceId: string, person: Person): Promise<string> {
  const row = await db
    .prepare('SELECT id FROM member WHERE "organizationId"=? AND "userId"=?')
    .get<{ id: string }>(workspaceId, person.authUserId);
  if (!row) throw new Error('member row missing');
  return row.id;
}

async function roleOf(workspaceId: string, person: Person): Promise<string> {
  const row = await db
    .prepare('SELECT role FROM member WHERE "organizationId"=? AND "userId"=?')
    .get<{ role: string }>(workspaceId, person.authUserId);
  return row?.role ?? '(none)';
}

/** A pending LinkedIn DM that needs an exact-payload approval. */
async function pendingDm(workspaceId: string): Promise<{ actionId: string; contentHash: string }> {
  const written = await recordAction(
    db,
    {
      workspaceId,
      kind: 'dm',
      targetRef: `https://linkedin.com/in/${id('person')}/`,
      status: 'planned',
      source: 'manual',
      plannedFor: NOW.toISOString()
    },
    NOW
  );
  await db
    .prepare('UPDATE linkedin_actions SET body=? WHERE workspace_id=? AND id=?')
    .run('Hello from the test', workspaceId, written.id);
  const review = await reviewLinkedInAction(db, workspaceId, written.id);
  if (!review) throw new Error('action not reviewable');
  return { actionId: written.id, contentHash: review.contentHash };
}

const ROLES = ['owner', 'manager', 'member'] as const;
type Expectation = Record<(typeof ROLES)[number], number>;
const OWNER_ONLY = (ownerStatus: number): Expectation => ({
  owner: ownerStatus,
  manager: 403,
  member: 403
});
const OWNER_OR_MANAGER = (status: number): Expectation => ({
  owner: status,
  manager: status,
  member: 403
});
const EVERYONE = (status: number): Expectation => ({
  owner: status,
  manager: status,
  member: status
});

describe('TRV-045 capability map over HTTP', () => {
  it('answers each guarded route group with the expected status for owner, manager and member', async () => {
    const { owner, manager, member, workspaceId } = await team();
    const people = { owner, manager, member };

    // Fixtures the owner sets up once.
    await owner.agent
      .post('/api/linkedin/manager/seats')
      .send({ seatKey: 'team-seat', label: 'Team LinkedIn', timezone: 'Europe/Zurich' })
      .expect(201);
    const list = (
      await owner.agent
        .post('/api/linkedin/manager/lead-lists')
        .send({ seatKey: 'team-seat', name: 'Team leads', sourceKind: 'csv' })
        .expect(201)
    ).body.list as { id: string };
    const workflowBody = (name: string) => ({
      name,
      scope: 'workspace',
      steps: [
        {
          id: 'view',
          action: 'profile_view',
          delayBefore: { amount: 0, unit: 'hours' },
          config: {}
        }
      ]
    });
    const workflow = (
      await owner.agent
        .post('/api/linkedin/manager/workflows')
        .send(workflowBody('Team flow'))
        .expect(201)
    ).body.workflow as { id: string };
    const campaign = (
      await owner.agent
        .post('/api/linkedin/manager/campaigns')
        .send({
          name: 'Team campaign',
          seatKey: 'team-seat',
          leadListId: list.id,
          workflowId: workflow.id
        })
        .expect(201)
    ).body.campaign as { id: string };
    const ledgerExport = (
      await owner.agent.post('/api/ledger/exports').send({ window: 30 }).expect(201)
    ).body as { id: string };
    const token = (
      await owner.agent.post('/api/agent-tokens').send({ name: 'Owner token' }).expect(201)
    ).body.record as { id: string };
    const approvals = {
      owner: await pendingDm(workspaceId),
      manager: await pendingDm(workspaceId),
      member: await pendingDm(workspaceId)
    };
    const memberMemberId = await memberRowId(workspaceId, member);

    type Row = {
      group: string;
      expect: Expectation;
      send: (who: (typeof ROLES)[number]) => request.Test;
    };
    const as = (who: (typeof ROLES)[number]) => people[who].agent;
    const rows: Row[] = [
      // Open to every role.
      {
        group: 'reports.view',
        expect: EVERYONE(200),
        send: (who) => as(who).get('/api/linkedin/manager/reports?range=7d')
      },
      {
        group: 'inbox.organize',
        expect: EVERYONE(200),
        send: (who) => as(who).get('/api/linkedin/inbox/organize/tags')
      },
      // Owner or manager.
      {
        group: 'outreach.approve',
        expect: OWNER_OR_MANAGER(200),
        send: (who) =>
          as(who)
            .post(`/api/linkedin/manager/action-approvals/${approvals[who].actionId}`)
            .send({ contentHash: approvals[who].contentHash })
      },
      {
        group: 'campaigns.manage_all',
        expect: OWNER_OR_MANAGER(200),
        send: (who) =>
          as(who)
            .patch(`/api/linkedin/manager/campaigns/${campaign.id}/owner`)
            .send({ ownerUserId: null })
      },
      {
        group: 'workflows.manage_workspace',
        expect: OWNER_OR_MANAGER(201),
        send: (who) =>
          as(who)
            .post('/api/linkedin/manager/workflows')
            .send(workflowBody(`Flow by ${who}`))
      },
      {
        group: 'seats.assign',
        expect: OWNER_OR_MANAGER(200),
        send: (who) =>
          as(who)
            .patch('/api/linkedin/manager/seats/team-seat')
            .send({ ownerUserId: owner.authUserId })
      },
      {
        group: 'lead_lists.manage',
        expect: OWNER_OR_MANAGER(200),
        send: (who) =>
          as(who)
            .patch(`/api/linkedin/manager/lead-lists/${list.id}`)
            .send({ name: `Renamed by ${who}` })
      },
      {
        group: 'exports.download',
        expect: OWNER_OR_MANAGER(200),
        send: (who) => as(who).get(`/api/ledger/exports/${ledgerExport.id}`)
      },
      {
        group: 'team.invite',
        expect: OWNER_OR_MANAGER(201),
        send: (who) =>
          as(who)
            .post('/api/team/members')
            .send({ email: uniqueEmail(`invitee-of-${who}`) })
      },
      // Owner only.
      {
        group: 'team.roles (invite a manager)',
        expect: OWNER_ONLY(201),
        send: (who) =>
          as(who)
            .post('/api/team/members')
            .send({ email: uniqueEmail(`manager-invitee-of-${who}`), role: 'manager' })
      },
      {
        group: 'team.roles (change a role)',
        expect: OWNER_ONLY(200),
        send: (who) => as(who).patch(`/api/team/members/${memberMemberId}`).send({ role: 'member' })
      },
      {
        group: 'account_safety.manage (seat limits)',
        expect: OWNER_ONLY(200),
        send: (who) =>
          as(who)
            .patch('/api/linkedin/manager/seats/team-seat')
            .send({ label: `Labelled by ${who}` })
      },
      {
        group: 'billing.manage',
        // No Billing service in this test: the owner passes the gate and is
        // told Billing is not configured.
        expect: OWNER_ONLY(503),
        send: (who) =>
          as(who)
            .post('/api/billing/checkout')
            .send({ planCode: 'growth_monthly_usd', nonce: `nonce-${who}-checkout` })
      },
      {
        group: 'policy.manage',
        expect: OWNER_ONLY(201),
        send: (who) =>
          as(who)
            .post('/api/policies')
            .send({
              name: `Ask first (${who})`,
              actionPattern: 'skill:*',
              effect: 'require_approval'
            })
      },
      {
        group: 'credentials.manage',
        expect: OWNER_ONLY(200),
        send: (who) => as(who).delete('/api/enrichment/key')
      },
      {
        group: 'integrations.manage',
        expect: OWNER_ONLY(200),
        send: (who) => as(who).get('/api/setup/webhooks')
      },
      {
        group: 'outbound_webhooks.manage',
        expect: OWNER_ONLY(200),
        send: (who) => as(who).get('/api/outbound-webhooks')
      },
      {
        group: 'api_tokens.manage',
        expect: OWNER_ONLY(200),
        send: (who) => as(who).delete(`/api/agent-tokens/${token.id}`)
      },
      {
        group: 'agent.configure',
        expect: OWNER_ONLY(200),
        send: (who) =>
          as(who).put('/api/agent-setup/budget').send({ monthlyCapCents: 5000, enabled: true })
      },
      {
        group: 'workspace.export',
        expect: OWNER_ONLY(200),
        send: (who) => as(who).get('/api/workspace/export')
      }
    ];

    const observed: string[] = [];
    const wanted: string[] = [];
    // Member first, owner last, so a denied attempt never consumes a fixture.
    for (const row of rows)
      for (const who of ['member', 'manager', 'owner'] as const) {
        const res = await row.send(who);
        observed.push(`${row.group} ${who} ${res.status}`);
        wanted.push(`${row.group} ${who} ${row.expect[who]}`);
      }
    expect(observed).toEqual(wanted);
  });

  it('refuses a manager every billing, policy, token, webhook, credential and role write', async () => {
    const { owner, manager, workspaceId } = await team();
    const ownerMemberId = await memberRowId(workspaceId, owner);
    const managerMemberId = await memberRowId(workspaceId, manager);
    const refusals: Array<[string, () => request.Test]> = [
      [
        'billing checkout',
        () =>
          manager.agent
            .post('/api/billing/checkout')
            .send({ planCode: 'growth_monthly_usd', nonce: 'nonce-manager-1' })
      ],
      [
        'billing preview',
        () => manager.agent.post('/api/billing/preview').send({ planCode: 'starter_monthly_usd' })
      ],
      [
        'billing change',
        () =>
          manager.agent
            .post('/api/billing/change')
            .send({ planCode: 'starter_monthly_usd', nonce: 'nonce-manager-2' })
      ],
      [
        'billing cancel',
        () => manager.agent.post('/api/billing/cancel').send({ nonce: 'nonce-manager-3' })
      ],
      [
        'billing resume',
        () => manager.agent.post('/api/billing/resume').send({ nonce: 'nonce-manager-4' })
      ],
      [
        'policy create',
        () =>
          manager.agent
            .post('/api/policies')
            .send({ name: 'Open', actionPattern: '*', effect: 'allow' })
      ],
      ['api token revoke', () => manager.agent.delete('/api/agent-tokens/tok_missing')],
      [
        'outbound webhook create',
        () =>
          manager.agent
            .post('/api/outbound-webhooks')
            .send({ url: 'https://example.com/hook', events: ['*'] })
      ],
      ['outbound webhook list', () => manager.agent.get('/api/outbound-webhooks')],
      [
        'BYOK model key',
        () => manager.agent.put('/api/agent-setup/key').send({ apiKey: 'sk-test' })
      ],
      [
        'Hunter key',
        () => manager.agent.put('/api/enrichment/key').send({ apiKey: 'hunter-test' })
      ],
      [
        'agent budget',
        () =>
          manager.agent.put('/api/agent-setup/budget').send({ monthlyCapCents: 100, enabled: true })
      ],
      [
        'LinkedIn hosted execution',
        () => manager.agent.post('/api/linkedin/hosted-execution').send({})
      ],
      ['companion pairing', () => manager.agent.post('/api/linkedin/companion/pair').send({})],
      [
        'promote self to owner',
        () => manager.agent.patch(`/api/team/members/${managerMemberId}`).send({ role: 'owner' })
      ],
      [
        'demote the owner',
        () => manager.agent.patch(`/api/team/members/${ownerMemberId}`).send({ role: 'member' })
      ],
      [
        'workspace deletion',
        () => manager.agent.delete('/api/workspace').send({ confirm: 'anything' })
      ],
      ['create agent principal', () => manager.agent.post('/api/agents').send({ name: 'Agent' })]
    ];
    const statuses: string[] = [];
    for (const [label, pending] of refusals) statuses.push(`${label} ${(await pending()).status}`);
    expect(statuses).toEqual(refusals.map(([label]) => `${label} 403`));

    // Better Auth's own role endpoint is closed to everyone, owner included:
    // only PATCH /api/team/members can change a role (and record who did).
    for (const person of [manager, owner]) {
      const direct = await person.agent
        .post('/api/auth/organization/update-member-role')
        .send({ memberId: managerMemberId, role: 'owner', organizationId: workspaceId });
      expect(direct.status).toBe(403);
    }
    expect(await roleOf(workspaceId, manager)).toBe('manager');
    expect(await roleOf(workspaceId, owner)).toBe('owner');
  });

  it('lets a manager approve outreach and records the manager as the approver', async () => {
    const { manager, workspaceId } = await team();
    const pending = await pendingDm(workspaceId);
    const approved = await manager.agent
      .post(`/api/linkedin/manager/action-approvals/${pending.actionId}`)
      .send({ contentHash: pending.contentHash })
      .expect(200);
    expect(approved.body.review.approved).toBe(true);
    const row = await db
      .prepare(
        'SELECT approved_by FROM linkedin_action_approvals WHERE workspace_id=? AND action_id=?'
      )
      .get<{ approved_by: string }>(workspaceId, pending.actionId);
    expect(row?.approved_by).toBe(manager.auth.userId);

    // The exact-payload rule still binds a manager.
    const other = await pendingDm(workspaceId);
    await manager.agent
      .post(`/api/linkedin/manager/action-approvals/${other.actionId}`)
      .send({ contentHash: HASH_ZERO })
      .expect(409);
  });
});

describe('TRV-045 role management', () => {
  it('records every role change as a domain event naming who, from and to', async () => {
    const { owner, manager, member, workspaceId } = await team();
    const memberId = await memberRowId(workspaceId, member);

    const promoted = await owner.agent
      .patch(`/api/team/members/${memberId}`)
      .send({ role: 'manager' })
      .expect(200);
    expect(promoted.body).toMatchObject({
      changed: true,
      member: { id: memberId, role: 'manager' }
    });
    expect((await member.agent.get('/api/auth/session').expect(200)).body.auth.role).toBe(
      'manager'
    );

    // Same role again is a no-op and writes nothing.
    await owner.agent
      .patch(`/api/team/members/${memberId}`)
      .send({ role: 'manager' })
      .expect(200)
      .expect((res) => expect(res.body.changed).toBe(false));

    await owner.agent.patch(`/api/team/members/${memberId}`).send({ role: 'member' }).expect(200);

    const events = await listDomainEvents(db, workspaceId, {
      streamType: 'workspace_member',
      streamId: memberId
    });
    expect(
      events.map((event) => ({
        type: event.eventType,
        actorType: event.actorType,
        actorId: event.actorId,
        from: event.payload.fromRole,
        to: event.payload.toRole,
        authUserId: event.payload.authUserId
      }))
    ).toEqual([
      {
        type: 'workspace.member_role_changed',
        actorType: 'user',
        actorId: owner.auth.userId,
        from: 'member',
        to: 'manager',
        authUserId: member.authUserId
      },
      {
        type: 'workspace.member_role_changed',
        actorType: 'user',
        actorId: owner.auth.userId,
        from: 'manager',
        to: 'member',
        authUserId: member.authUserId
      }
    ]);

    // A refused change writes no event.
    await manager.agent
      .patch(`/api/team/members/${memberId}`)
      .send({ role: 'manager' })
      .expect(403);
    await owner.agent.patch(`/api/team/members/${memberId}`).send({ role: 'admin' }).expect(400);
    expect(
      await listDomainEvents(db, workspaceId, {
        streamType: 'workspace_member',
        streamId: memberId
      })
    ).toHaveLength(2);
  });

  it('never demotes or removes the last owner', async () => {
    const { owner, manager, workspaceId } = await team();
    const ownerMemberId = await memberRowId(workspaceId, owner);
    const managerMemberId = await memberRowId(workspaceId, manager);

    const demoteSelf = await owner.agent
      .patch(`/api/team/members/${ownerMemberId}`)
      .send({ role: 'manager' });
    expect(demoteSelf.status).toBe(400);
    expect(demoteSelf.body.error).toMatch(/owner/i);
    expect(await roleOf(workspaceId, owner)).toBe('owner');

    const removeSelf = await owner.agent
      .post('/api/auth/organization/remove-member')
      .send({ memberIdOrEmail: ownerMemberId, organizationId: workspaceId });
    expect(removeSelf.status).toBeGreaterThanOrEqual(400);
    expect(await roleOf(workspaceId, owner)).toBe('owner');

    // With a second owner in place, the first may step down.
    await owner.agent
      .patch(`/api/team/members/${managerMemberId}`)
      .send({ role: 'owner' })
      .expect(200);
    await owner.agent
      .patch(`/api/team/members/${ownerMemberId}`)
      .send({ role: 'manager' })
      .expect(200);
    expect(await roleOf(workspaceId, owner)).toBe('manager');
    expect(await roleOf(workspaceId, manager)).toBe('owner');
    expect(
      (await listDomainEvents(db, workspaceId, { streamType: 'workspace_member' })).map(
        (event) => `${event.streamId}:${event.payload.fromRole}->${event.payload.toRole}`
      )
    ).toEqual([`${managerMemberId}:manager->owner`, `${ownerMemberId}:owner->manager`]);

    // And the new sole owner is now the protected one.
    await manager.agent
      .patch(`/api/team/members/${managerMemberId}`)
      .send({ role: 'member' })
      .expect(400);
  });

  it('lets only the owner invite a manager, through Trevra and through Better Auth', async () => {
    const { owner, manager, member, workspaceId } = await team();

    const invited = await owner.agent
      .post('/api/team/members')
      .send({ email: uniqueEmail('new-manager'), role: 'manager' })
      .expect(201);
    expect(invited.body.invitation.role).toBe('manager');

    await manager.agent
      .post('/api/team/members')
      .send({ email: uniqueEmail('blocked-manager'), role: 'manager' })
      .expect(403);
    await manager.agent
      .post('/api/team/members')
      .send({ email: uniqueEmail('blocked-owner'), role: 'owner' })
      .expect(403);
    await member.agent
      .post('/api/team/members')
      .send({ email: uniqueEmail('blocked-by-member') })
      .expect(403);

    const directManagerInvite = await manager.agent
      .post('/api/auth/organization/invite-member')
      .send({ email: uniqueEmail('direct'), role: 'manager', organizationId: workspaceId });
    expect(directManagerInvite.status).toBe(403);

    const memberInvite = await manager.agent
      .post('/api/team/members')
      .send({ email: uniqueEmail('by-manager') })
      .expect(201);
    expect(memberInvite.body.invitation.role).toBe('member');

    // A manager cancels a member's invitation but not a manager's.
    await manager.agent
      .post('/api/auth/organization/cancel-invitation')
      .send({ invitationId: invited.body.invitation.id })
      .expect(403);
    await manager.agent
      .post('/api/auth/organization/cancel-invitation')
      .send({ invitationId: memberInvite.body.invitation.id })
      .expect(200);

    const pending = await db
      .prepare('SELECT email,role,status FROM invitation WHERE "organizationId"=? ORDER BY email')
      .all<{ email: string; role: string; status: string }>(workspaceId);
    expect(pending.filter((row) => row.status === 'pending').map((row) => row.role)).toEqual([
      'manager'
    ]);
  });

  it('lets a manager remove a member but not another manager or an owner', async () => {
    const { owner, manager, member, workspaceId } = await team();
    const second = await signUp('second-manager');
    await join(second, workspaceId, 'manager');
    const ownerMemberId = await memberRowId(workspaceId, owner);
    const secondMemberId = await memberRowId(workspaceId, second);
    const memberMemberId = await memberRowId(workspaceId, member);

    for (const target of [ownerMemberId, secondMemberId]) {
      const refused = await manager.agent
        .post('/api/auth/organization/remove-member')
        .send({ memberIdOrEmail: target, organizationId: workspaceId });
      expect(refused.status).toBe(403);
    }
    const byEmail = await manager.agent
      .post('/api/auth/organization/remove-member')
      .send({ memberIdOrEmail: second.email, organizationId: workspaceId });
    expect(byEmail.status).toBe(403);
    expect(await roleOf(workspaceId, second)).toBe('manager');
    expect(await roleOf(workspaceId, owner)).toBe('owner');

    // A member still cannot remove anyone: the plugin's own refusal, unchanged.
    const byMember = await member.agent
      .post('/api/auth/organization/remove-member')
      .send({ memberIdOrEmail: secondMemberId, organizationId: workspaceId });
    expect(byMember.status).toBe(401);
    expect(await roleOf(workspaceId, second)).toBe('manager');

    await manager.agent
      .post('/api/auth/organization/remove-member')
      .send({ memberIdOrEmail: memberMemberId, organizationId: workspaceId })
      .expect(200);
    expect(await roleOf(workspaceId, member)).toBe('(none)');

    // The owner may remove a manager.
    await owner.agent
      .post('/api/auth/organization/remove-member')
      .send({ memberIdOrEmail: secondMemberId, organizationId: workspaceId })
      .expect(200);
  });

  it('keeps a manager and an owner inside their own workspace', async () => {
    const a = await team();
    const b = await team();
    const bMemberId = await memberRowId(b.workspaceId, b.member);

    // A's owner cannot change a role in B.
    await a.owner.agent
      .patch(`/api/team/members/${bMemberId}`)
      .send({ role: 'manager' })
      .expect(404);
    expect(await roleOf(b.workspaceId, b.member)).toBe('member');

    // A's manager cannot approve B's outreach or rename B's lead list.
    const bPending = await pendingDm(b.workspaceId);
    await a.manager.agent
      .post(`/api/linkedin/manager/action-approvals/${bPending.actionId}`)
      .send({ contentHash: bPending.contentHash })
      .expect(404);
    const approval = await db
      .prepare('SELECT approved_by FROM linkedin_action_approvals WHERE action_id=?')
      .get(bPending.actionId);
    expect(approval).toBeUndefined();

    const bList = (
      await b.owner.agent
        .post('/api/linkedin/manager/lead-lists')
        .send({ name: 'B leads', sourceKind: 'csv' })
        .expect(201)
    ).body.list as { id: string };
    await a.manager.agent
      .patch(`/api/linkedin/manager/lead-lists/${bList.id}`)
      .send({ name: 'Taken over' })
      .expect(404);

    // A's manager cannot remove B's member through Better Auth either.
    const crossRemove = await a.manager.agent
      .post('/api/auth/organization/remove-member')
      .send({ memberIdOrEmail: bMemberId, organizationId: b.workspaceId });
    expect(crossRemove.status).toBeGreaterThanOrEqual(400);
    expect(await roleOf(b.workspaceId, b.member)).toBe('member');

    // And B's events never mention A's people.
    expect(
      await listDomainEvents(db, b.workspaceId, { streamType: 'workspace_member' })
    ).toHaveLength(0);
  });
});
