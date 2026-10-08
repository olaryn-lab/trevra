import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nangoMock = vi.hoisted(() => ({
  get: vi.fn(async (_config: Record<string, unknown>) => ({ data: {}, headers: {} }))
}));
vi.mock('@nangohq/node', () => ({
  Nango: class {
    get = nangoMock.get;
  }
}));

import { openDatabase, type Db } from '../db.js';
import { setMailboxDkimSelector } from './channel.js';
import type { DnsResolver } from './deliverability.js';
import { dkimSelectorSchema, readDkimSelector, writeDkimSelector } from './dkim-selector.js';

const WORKSPACE = 'ws_email_dkim_selector';
const OTHER = 'ws_email_dkim_selector_other';
const USER = 'usr_email_dkim_selector';
const CONNECTION = 'conn_email_dkim_selector';
const NOW = new Date('2026-10-07T09:00:00.000Z');
const DKIM = 'v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAx3';
let db: Db;

function recordingResolver(): DnsResolver & {
  calls: string[];
  records: Record<string, string[]>;
} {
  const calls: string[] = [];
  const records: Record<string, string[]> = {
    'acme.test': ['v=spf1 include:_spf.google.com ~all'],
    '_spf.google.com': ['v=spf1 ip4:203.0.113.0/24 ~all'],
    'zmail._domainkey.acme.test': [DKIM],
    '_dmarc.acme.test': ['v=DMARC1; p=none']
  };
  return {
    calls,
    records,
    async resolveTxt(name: string) {
      calls.push(name);
      const value = records[name];
      if (!value) throw Object.assign(new Error(`ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
      return value.map((record) => [record]);
    }
  };
}

beforeEach(async () => {
  vi.stubEnv('NANGO_API_KEY', 'test-nango-key');
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  for (const workspaceId of [WORKSPACE, OTHER]) {
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(workspaceId, workspaceId, NOW.toISOString());
  }
  await db
    .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
    .run(USER, WORKSPACE, 'owner@acme.test', 'Owner', NOW.toISOString());
  await db
    .prepare(
      `INSERT INTO connections
       (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,
        mailbox_address,created_at,updated_at)
       VALUES (?,?,'gmail','trevra-gmail',?,NULL,'connected',0,'founder@acme.test',?,?)`
    )
    .run(CONNECTION, WORKSPACE, `${CONNECTION}-external`, NOW.toISOString(), NOW.toISOString());
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const workspaceId of [WORKSPACE, OTHER]) {
    await db?.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  }
  await db?.close();
});

describe('DKIM selector store', () => {
  it('accepts DNS-label selectors, lowercased and trimmed, and rejects everything else', () => {
    expect(dkimSelectorSchema.parse('  ZMail ')).toBe('zmail');
    expect(dkimSelectorSchema.parse('s1.mail-2026')).toBe('s1.mail-2026');
    for (const bad of [
      '',
      'zmail._domainkey',
      'z mail',
      '../x',
      '-zmail',
      'zmail-',
      'a'.repeat(201),
      'z_mail'
    ]) {
      expect(dkimSelectorSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('writes, replaces and clears one selector per workspace and domain', async () => {
    await writeDkimSelector(
      db,
      { workspaceId: WORKSPACE, domain: 'Acme.Test.', selector: 'zmail', actorUserId: USER },
      NOW
    );
    expect(await readDkimSelector(db, WORKSPACE, 'acme.test')).toBe('zmail');
    expect(await readDkimSelector(db, OTHER, 'acme.test')).toBeNull();
    await writeDkimSelector(
      db,
      { workspaceId: WORKSPACE, domain: 'acme.test', selector: 'zmail2', actorUserId: USER },
      NOW
    );
    expect(await readDkimSelector(db, WORKSPACE, 'acme.test')).toBe('zmail2');
    await writeDkimSelector(
      db,
      { workspaceId: WORKSPACE, domain: 'acme.test', selector: null, actorUserId: USER },
      NOW
    );
    expect(await readDkimSelector(db, WORKSPACE, 'acme.test')).toBeNull();
  });

  it('records the acting user on write and on replace by a different actor', async () => {
    await db
      .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
      .run(`${USER}_2`, WORKSPACE, 'owner2@acme.test', 'Owner Two', NOW.toISOString());
    const actor = () =>
      db
        .prepare(
          'SELECT updated_by_user_id AS actor FROM email_dkim_selectors WHERE workspace_id=? AND domain=?'
        )
        .get<{ actor: string }>(WORKSPACE, 'acme.test');
    await writeDkimSelector(
      db,
      { workspaceId: WORKSPACE, domain: 'acme.test', selector: 'zmail', actorUserId: USER },
      NOW
    );
    expect((await actor())?.actor).toBe(USER);
    await writeDkimSelector(
      db,
      { workspaceId: WORKSPACE, domain: 'acme.test', selector: 'zmail2', actorUserId: `${USER}_2` },
      NOW
    );
    expect((await actor())?.actor).toBe(`${USER}_2`);
  });
});

describe('setMailboxDkimSelector', () => {
  it("stores the mailbox domain's selector and re-checks DNS with it first", async () => {
    const resolver = recordingResolver();
    await setMailboxDkimSelector(
      db,
      { workspaceId: WORKSPACE, connectionId: CONNECTION, selector: 'ZMAIL', actorUserId: USER },
      { resolver, now: NOW }
    );
    expect(await readDkimSelector(db, WORKSPACE, 'acme.test')).toBe('zmail');
    expect(resolver.calls.filter((name) => name.includes('._domainkey.'))[0]).toBe(
      'zmail._domainkey.acme.test'
    );
    const stored = await db
      .prepare(
        `SELECT dkim_json->>'selector' AS selector FROM email_deliverability_checks
         WHERE workspace_id=? AND domain='acme.test' AND provider='google'`
      )
      .get<{ selector: string }>(WORKSPACE);
    expect(stored?.selector).toBe('zmail');
  });

  it('replaces and clears the stored result even while the cached check is still fresh', async () => {
    const resolver = recordingResolver();
    resolver.records['zmail2._domainkey.acme.test'] = [DKIM];
    const storedSelector = async () =>
      (
        await db
          .prepare(
            `SELECT dkim_json->>'selector' AS selector FROM email_deliverability_checks
             WHERE workspace_id=? AND domain='acme.test' AND provider='google'`
          )
          .get<{ selector: string | null }>(WORKSPACE)
      )?.selector;
    for (const selector of ['zmail', 'zmail2']) {
      await setMailboxDkimSelector(
        db,
        { workspaceId: WORKSPACE, connectionId: CONNECTION, selector, actorUserId: USER },
        { resolver, now: NOW }
      );
      expect(await storedSelector()).toBe(selector);
    }
    await setMailboxDkimSelector(
      db,
      { workspaceId: WORKSPACE, connectionId: CONNECTION, selector: null, actorUserId: USER },
      { resolver, now: NOW }
    );
    expect(await readDkimSelector(db, WORKSPACE, 'acme.test')).toBeNull();
    expect(await storedSelector()).not.toBe('zmail2');
    expect(await storedSelector()).not.toBe('zmail');
  });

  it('refuses a bad selector or another workspace mailbox and stores nothing', async () => {
    await expect(
      setMailboxDkimSelector(db, {
        workspaceId: WORKSPACE,
        connectionId: CONNECTION,
        selector: 'zmail._domainkey',
        actorUserId: USER
      })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      setMailboxDkimSelector(db, {
        workspaceId: OTHER,
        connectionId: CONNECTION,
        selector: 'zmail',
        actorUserId: USER
      })
    ).rejects.toMatchObject({ status: 404 });
    const rows = await db
      .prepare(
        'SELECT COUNT(*)::int AS total FROM email_dkim_selectors WHERE workspace_id IN (?,?)'
      )
      .get<{ total: number }>(WORKSPACE, OTHER);
    expect(rows?.total).toBe(0);
  });
});
