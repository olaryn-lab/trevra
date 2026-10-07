import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { openDatabase, type Db } from '../db.js';
import { recordSeatIdentity, seatIdentityKey } from './identity.js';
import { getSeat, upsertSeat } from './seats.js';

describe('seatIdentityKey', () => {
  it('folds every rendering of one profile into one key', () => {
    const key = 'https://www.linkedin.com/in/shared-founder';
    expect(seatIdentityKey('https://www.linkedin.com/in/shared-founder/')).toBe(key);
    expect(seatIdentityKey('https://linkedin.com/in/Shared-Founder?trk=nav')).toBe(key);
    expect(seatIdentityKey('https://www.linkedin.com/in/shared-founder/#about')).toBe(key);
  });

  it('refuses anything that is not a LinkedIn member profile', () => {
    expect(seatIdentityKey(null)).toBeNull();
    expect(seatIdentityKey('')).toBeNull();
    expect(seatIdentityKey('https://evil.example/in/shared-founder/')).toBeNull();
    expect(seatIdentityKey('https://www.linkedin.com/company/trevra/')).toBeNull();
  });
});

describe('recordSeatIdentity', () => {
  const A = 'ws_linkedin_identity_a';
  const B = 'ws_linkedin_identity_b';
  const NOW = new Date('2026-08-06T09:00:00.000Z');
  const PROFILE = 'https://www.linkedin.com/in/shared-founder/';
  /** One Trevra user, a member of both workspaces. */
  const FOUNDER = 'usr_linkedin_identity_founder';
  /** Somebody else, a member of B only. */
  const RIVAL = 'usr_linkedin_identity_rival';
  let db: Db;

  beforeAll(async () => migrateAuthDatabase());
  afterAll(async () => closeAuthDatabase());

  /**
   * Membership exactly as the API checks it: Trevra's `users` row, the
   * better-auth `user` with the same email, and its `member` row in the
   * organization whose id is the workspace id.
   */
  async function member(userId: string, home: string, workspaceIds: string[]): Promise<void> {
    const at = NOW.toISOString();
    const email = `${userId}@trevra.test`;
    await db
      .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
      .run(userId, home, email, userId, at);
    await db
      .prepare(
        `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt")
         VALUES (?,?,?,false,?,?) ON CONFLICT (id) DO NOTHING`
      )
      .run(`au_${userId}`, userId, email, at, at);
    for (const workspaceId of workspaceIds) {
      await db
        .prepare(
          `INSERT INTO organization (id,name,slug,"createdAt") VALUES (?,?,?,?) ON CONFLICT (id) DO NOTHING`
        )
        .run(workspaceId, workspaceId, workspaceId, at);
      await db
        .prepare(
          `INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES (?,?,?,'owner',?)`
        )
        .run(`mem_${workspaceId}_${userId}`, workspaceId, `au_${userId}`, at);
    }
  }

  async function forgetMembers(): Promise<void> {
    await db?.prepare('DELETE FROM member WHERE "organizationId" = ANY(?::text[])').run([A, B]);
    await db?.prepare('DELETE FROM organization WHERE id = ANY(?::text[])').run([A, B]);
    await db
      ?.prepare('DELETE FROM "user" WHERE id = ANY(?::text[])')
      .run([`au_${FOUNDER}`, `au_${RIVAL}`]);
  }

  beforeEach(async () => {
    db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
    await forgetMembers();
    for (const workspaceId of [A, B]) {
      await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
      await db
        .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
        .run(workspaceId, workspaceId, NOW.toISOString());
      await upsertSeat(db, workspaceId, { label: `Seat ${workspaceId}`, timezone: 'UTC' }, NOW);
    }
    await member(FOUNDER, A, [A, B]);
    await member(RIVAL, B, [B]);
  });

  afterEach(async () => {
    await forgetMembers();
    for (const workspaceId of [A, B])
      await db?.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
    await db?.close();
  });

  it('links seats in two workspaces signed in as one member and shows each side only a count', async () => {
    expect(await recordSeatIdentity(db, A, 'owner', PROFILE, NOW, FOUNDER)).toBe(
      'https://www.linkedin.com/in/shared-founder'
    );
    expect((await getSeat(db, A, 'owner'))?.linkedSeatCount).toBe(0);

    await recordSeatIdentity(
      db,
      B,
      'owner',
      'https://linkedin.com/in/Shared-Founder',
      NOW,
      FOUNDER
    );
    const seatA = await getSeat(db, A, 'owner');
    expect(seatA?.identityConfirmedAt).toBe(NOW.toISOString());
    expect(seatA?.linkedSeatCount).toBe(1);
    expect(JSON.stringify(seatA)).not.toContain(B);
    expect(JSON.stringify(seatA)).not.toContain(`Seat ${B}`);
  });

  it('does not link one profile key bound by two different users', async () => {
    // The key is read through a browser the tenant controls, so B claiming
    // A's founder profile must not attach B to A's budget.
    await recordSeatIdentity(db, A, 'owner', PROFILE, NOW, FOUNDER);
    await recordSeatIdentity(db, B, 'owner', PROFILE, NOW, RIVAL);
    expect((await getSeat(db, A, 'owner'))?.linkedSeatCount).toBe(0);
    expect((await getSeat(db, B, 'owner'))?.linkedSeatCount).toBe(0);
  });

  it('does not link once the shared user is no longer a member of one workspace', async () => {
    await recordSeatIdentity(db, A, 'owner', PROFILE, NOW, FOUNDER);
    await recordSeatIdentity(db, B, 'owner', PROFILE, NOW, FOUNDER);
    expect((await getSeat(db, A, 'owner'))?.linkedSeatCount).toBe(1);

    await db.prepare('DELETE FROM member WHERE id=?').run(`mem_${B}_${FOUNDER}`);
    expect((await getSeat(db, A, 'owner'))?.linkedSeatCount).toBe(0);
    expect((await getSeat(db, B, 'owner'))?.linkedSeatCount).toBe(0);
  });

  it('records an identity with no known user, and it links nothing', async () => {
    await recordSeatIdentity(db, A, 'owner', PROFILE, NOW, FOUNDER);
    await recordSeatIdentity(db, B, 'owner', PROFILE, NOW);
    expect((await getSeat(db, B, 'owner'))?.identityConfirmedAt).toBe(NOW.toISOString());
    expect((await getSeat(db, A, 'owner'))?.linkedSeatCount).toBe(0);
  });

  it('forgets the link when the signed-in profile cannot be read as a member', async () => {
    await recordSeatIdentity(db, A, 'owner', PROFILE, NOW, FOUNDER);
    expect(await recordSeatIdentity(db, A, 'owner', null, NOW, FOUNDER)).toBeNull();
    const seatA = await getSeat(db, A, 'owner');
    expect(seatA?.identityConfirmedAt).toBeNull();
    expect(seatA?.linkedSeatCount).toBe(0);
  });

  it('never links budgets on a profile URL an operator typed', async () => {
    // `profileUrl` on the seat is operator input. Only detection writes an
    // identity, so two seats claiming one profile stay on separate budgets.
    for (const workspaceId of [A, B])
      await upsertSeat(
        db,
        workspaceId,
        { label: `Seat ${workspaceId}`, timezone: 'UTC', profileUrl: PROFILE },
        NOW
      );
    const seatA = await getSeat(db, A, 'owner');
    expect(seatA?.profileUrl).toBe(PROFILE);
    expect(seatA?.identityConfirmedAt).toBeNull();
    expect(seatA?.linkedSeatCount).toBe(0);
  });
});
