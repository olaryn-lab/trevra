import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { openDatabase, type Db } from '../db.js';
import { listDomainEvents } from '../control-plane/events.js';
import {
  FTC_CAN_SPAM_GUIDE_URL,
  getSenderIdentity,
  saveSenderIdentity,
  senderIdentityBlockers
} from './sender-identity.js';

const WORKSPACE = 'ws_sender_identity_test';
const NOW = new Date('2026-08-21T09:00:00.000Z');
const ADDRESS = 'Bahnhofstrasse 1, 8001 Zurich, Switzerland';
let db: Db;

const save = (input: unknown) =>
  saveSenderIdentity(db, { workspaceId: WORKSPACE, actorUserId: null, input }, NOW);

async function updates() {
  return (
    await listDomainEvents(db, WORKSPACE, { streamType: 'workspace', streamId: WORKSPACE })
  ).filter((event) => event.eventType === 'sender_identity.updated');
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Sender identity', NOW.toISOString());
});

afterEach(async () => {
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

describe('workspace sender identity', () => {
  it('starts empty and blocks email outreach for both missing fields, citing the FTC guide', async () => {
    expect(await getSenderIdentity(db, WORKSPACE)).toEqual({
      legalName: null,
      postalAddress: null,
      privacyPolicyUrl: null,
      updatedAt: null
    });
    const blockers = await senderIdentityBlockers(db, WORKSPACE);
    expect(blockers.map((blocker) => blocker.code)).toEqual([
      'sender_postal_address_missing',
      'sender_privacy_url_missing'
    ]);
    expect(blockers[0]!.message).toContain(FTC_CAN_SPAM_GUIDE_URL);
    expect(blockers.every((blocker) => blocker.actionHref === '/setup/workspace')).toBe(true);
  });

  it('records which fields changed, never their values, and only when something changed', async () => {
    await save({ legalName: 'Northwind GmbH', postalAddress: ADDRESS });
    expect((await senderIdentityBlockers(db, WORKSPACE)).map((blocker) => blocker.code)).toEqual([
      'sender_privacy_url_missing'
    ]);

    const saved = await save({ privacyPolicyUrl: 'https://northwind.example/privacy' });
    expect(saved).toMatchObject({
      legalName: 'Northwind GmbH',
      postalAddress: ADDRESS,
      privacyPolicyUrl: 'https://northwind.example/privacy',
      updatedAt: NOW.toISOString()
    });
    expect(await senderIdentityBlockers(db, WORKSPACE)).toEqual([]);

    await save({ privacyPolicyUrl: 'https://northwind.example/privacy' });
    const events = await updates();
    expect(events.map((event) => event.payload)).toEqual([
      { fields: ['legalName', 'postalAddress'] },
      { fields: ['privacyPolicyUrl'] }
    ]);
    expect(JSON.stringify(events)).not.toContain('Bahnhofstrasse');
  });

  it('treats an absent field as unchanged and a blank one as cleared', async () => {
    await save({
      legalName: 'Northwind GmbH',
      postalAddress: ADDRESS,
      privacyPolicyUrl: 'https://northwind.example/privacy'
    });
    await save({ postalAddress: '   ' });
    expect(await getSenderIdentity(db, WORKSPACE)).toMatchObject({
      legalName: 'Northwind GmbH',
      postalAddress: null
    });
    expect((await senderIdentityBlockers(db, WORKSPACE)).map((blocker) => blocker.code)).toEqual([
      'sender_postal_address_missing'
    ]);
  });

  it('refuses a privacy policy URL that is not https, and unknown fields', async () => {
    await expect(
      save({ privacyPolicyUrl: 'http://northwind.example/privacy' })
    ).rejects.toBeInstanceOf(ZodError);
    await expect(save({ footer: 'x' })).rejects.toBeInstanceOf(ZodError);
    expect(await updates()).toEqual([]);
  });
});
