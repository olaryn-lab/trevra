import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  let db: Db;

  beforeEach(async () => {
    db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
    for (const workspaceId of [A, B]) {
      await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
      await db
        .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
        .run(workspaceId, workspaceId, NOW.toISOString());
      await upsertSeat(db, workspaceId, { label: `Seat ${workspaceId}`, timezone: 'UTC' }, NOW);
    }
  });

  afterEach(async () => {
    for (const workspaceId of [A, B])
      await db?.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
    await db?.close();
  });

  it('links seats in two workspaces signed in as one member and shows each side only a count', async () => {
    expect(await recordSeatIdentity(db, A, 'owner', PROFILE, NOW)).toBe(
      'https://www.linkedin.com/in/shared-founder'
    );
    expect((await getSeat(db, A, 'owner'))?.linkedSeatCount).toBe(0);

    await recordSeatIdentity(db, B, 'owner', 'https://linkedin.com/in/Shared-Founder', NOW);
    const seatA = await getSeat(db, A, 'owner');
    expect(seatA?.identityConfirmedAt).toBe(NOW.toISOString());
    expect(seatA?.linkedSeatCount).toBe(1);
    expect(JSON.stringify(seatA)).not.toContain(B);
    expect(JSON.stringify(seatA)).not.toContain(`Seat ${B}`);
  });

  it('forgets the link when the signed-in profile cannot be read as a member', async () => {
    await recordSeatIdentity(db, A, 'owner', PROFILE, NOW);
    expect(await recordSeatIdentity(db, A, 'owner', null, NOW)).toBeNull();
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
