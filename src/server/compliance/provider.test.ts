import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import {
  emailComplianceFooterUnavailable,
  OUTREACH_OPT_OUT_SENTENCE
} from '../email/compliance.js';
import { saveSenderIdentity } from './sender-identity.js';
import {
  createSenderComplianceProvider,
  SENDER_COMPLIANCE_READ_TIMEOUT_MS,
  senderComplianceProvider
} from './provider.js';

const WORKSPACE = 'ws_sender_compliance_provider';
const OTHER = 'ws_sender_compliance_other';
const NOW = new Date('2026-08-21T09:00:00.000Z');
const ADDRESS = 'Bahnhofstrasse 1, 8001 Zurich, Switzerland';
const PRIVACY = 'https://northwind.example/privacy';
let db: Db;

const save = (input: unknown, workspaceId = WORKSPACE) =>
  saveSenderIdentity(db, { workspaceId, actorUserId: null, input }, NOW);

const codes = async (workspaceId = WORKSPACE) =>
  (await senderComplianceProvider.blockers(db, workspaceId, null)).map((issue) => issue.code);

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  for (const workspaceId of [WORKSPACE, OTHER]) {
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(workspaceId, workspaceId, NOW.toISOString());
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const workspaceId of [WORKSPACE, OTHER]) {
    await db?.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  }
  await db?.close();
});

describe('sender compliance provider', () => {
  it('has no footer, and names each missing field, until the address and privacy URL are saved', async () => {
    expect(await senderComplianceProvider.footer(db, WORKSPACE)).toBeNull();
    const issues = await senderComplianceProvider.blockers(db, WORKSPACE, null);
    expect(issues.map((issue) => [issue.code, issue.actionHref])).toEqual([
      ['sender_postal_address_missing', '/setup/workspace'],
      ['sender_privacy_url_missing', '/setup/workspace']
    ]);

    await save({ legalName: 'Northwind GmbH', postalAddress: ADDRESS });
    expect(await senderComplianceProvider.footer(db, WORKSPACE)).toBeNull();
    expect(await codes()).toEqual(['sender_privacy_url_missing']);
  });

  it('builds the footer from the saved identity and ends it with the opt-out sentence', async () => {
    await save({ legalName: 'Northwind GmbH', postalAddress: ADDRESS, privacyPolicyUrl: PRIVACY });

    expect(await senderComplianceProvider.footer(db, WORKSPACE)).toBe(
      `Northwind GmbH\n${ADDRESS}\nPrivacy policy: ${PRIVACY}\n${OUTREACH_OPT_OUT_SENTENCE}`
    );
    expect(await codes()).toEqual([]);
    // Another workspace never borrows this one's identity.
    expect(await senderComplianceProvider.footer(db, OTHER)).toBeNull();
    expect(await codes(OTHER)).toEqual([
      'sender_postal_address_missing',
      'sender_privacy_url_missing'
    ]);

    // The legal name is optional: the footer leaves its line out.
    await save({ legalName: '' });
    expect(await senderComplianceProvider.footer(db, WORKSPACE)).toBe(
      `${ADDRESS}\nPrivacy policy: ${PRIVACY}\n${OUTREACH_OPT_OUT_SENTENCE}`
    );
  });

  it('fails closed when the identity read fails or misses its deadline', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(SENDER_COMPLIANCE_READ_TIMEOUT_MS).toBeGreaterThan(0);
    const hanging = {
      prepare: () => ({ get: () => new Promise(() => undefined) })
    } as unknown as Db;
    const failing = {
      prepare: () => ({
        get: async () => {
          throw new Error('connection terminated');
        }
      })
    } as unknown as Db;
    const provider = createSenderComplianceProvider({ timeoutMs: 25 });

    for (const broken of [hanging, failing]) {
      expect(await provider.footer(broken, WORKSPACE)).toBeNull();
      expect(await provider.blockers(broken, WORKSPACE, null)).toEqual([
        emailComplianceFooterUnavailable()
      ]);
    }
    expect(logged).toHaveBeenCalledTimes(4);
  });

  it('is registered at both process entry points and never inside createApp', async () => {
    const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');
    const registration = 'registerEmailComplianceProvider(senderComplianceProvider)';
    expect(await read('../index.ts')).toContain(registration);
    expect(await read('../../worker/index.ts')).toContain(registration);
    expect(await read('../app.ts')).not.toContain('registerEmailComplianceProvider');
  });
});
