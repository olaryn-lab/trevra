import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DnsResolver } from './deliverability.js';

const nangoMock = vi.hoisted(() => ({
  get: vi.fn(async (_config: Record<string, unknown>) => ({
    data: {} as Record<string, unknown>,
    headers: {}
  }))
}));
vi.mock('@nangohq/node', () => ({
  Nango: class {
    get = nangoMock.get;
  }
}));

const { openDatabase } = await import('../db.js');
const {
  DELIVERABILITY_SWEEP_LOCK,
  getSenderDeliverability,
  readSenderDeliverability,
  refreshDueEmailDeliverability
} = await import('./sender-deliverability.js');
const { listSendingMailboxes, resolveMailboxAddress } = await import('./mailbox-address.js');

type Db = Awaited<ReturnType<typeof openDatabase>>;
const WORKSPACE = 'ws_email_sender_deliverability';
const NOW = new Date('2026-10-06T09:00:00.000Z');
const MINUTE = 60_000;
let db: Db;

const DKIM = 'v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAx3';

function resolverFor(records: Record<string, string[]>): DnsResolver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async resolveTxt(name: string) {
      calls.push(name);
      const value = records[name];
      if (!value) throw Object.assign(new Error(`ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
      return value.map((record) => [record]);
    }
  };
}

/** Answers like `resolverFor`, except that any name under a `hanging` domain never answers. */
function slowResolverFor(
  records: Record<string, string[]>,
  hanging: string[]
): DnsResolver & { calls: string[] } {
  const fast = resolverFor(records);
  return {
    calls: fast.calls,
    async resolveTxt(name: string) {
      if (hanging.some((domain) => name === domain || name.endsWith(`.${domain}`))) {
        fast.calls.push(name);
        return new Promise<string[][]>(() => undefined);
      }
      return fast.resolveTxt(name);
    }
  };
}

function passingRecords(domain: string): Record<string, string[]> {
  return {
    '_spf.google.com': ['v=spf1 ip4:203.0.113.0/24 ~all'],
    [domain]: ['v=spf1 include:_spf.google.com ~all'],
    [`google._domainkey.${domain}`]: [DKIM],
    [`_dmarc.${domain}`]: ['v=DMARC1; p=none']
  };
}

async function insertConnection(input: {
  id: string;
  provider: string;
  status?: string;
  isDemo?: number;
  updatedAt?: string;
}) {
  await db
    .prepare(
      `INSERT INTO connections (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      input.id,
      WORKSPACE,
      input.provider,
      `trevra-${input.provider}`,
      `${input.id}-external`,
      'owner@example.test',
      input.status ?? 'connected',
      input.isDemo ?? 0,
      NOW.toISOString(),
      input.updatedAt ?? NOW.toISOString()
    );
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Sender deliverability', NOW.toISOString());
  vi.stubEnv('NANGO_API_KEY', 'test-nango-key');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  nangoMock.get.mockReset();
  nangoMock.get.mockResolvedValue({ data: {}, headers: {} });
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

describe('cached sender deliverability', () => {
  it('trusts a passing answer for a day and re-checks on demand', async () => {
    const resolver = resolverFor(passingRecords('acme.test'));
    const first = await getSenderDeliverability(
      db,
      WORKSPACE,
      { domain: 'Acme.test', provider: 'google' },
      { resolver, now: NOW }
    );
    expect(first).toMatchObject({ domain: 'acme.test', status: 'pass' });
    expect(first.expiresAt).toBe(new Date(NOW.getTime() + 24 * 60 * MINUTE).toISOString());
    const lookups = resolver.calls.length;
    expect(lookups).toBeGreaterThan(0);

    await getSenderDeliverability(
      db,
      WORKSPACE,
      { domain: 'acme.test', provider: 'google' },
      { resolver, now: new Date(NOW.getTime() + 60 * MINUTE) }
    );
    expect(resolver.calls.length).toBe(lookups);

    await getSenderDeliverability(
      db,
      WORKSPACE,
      { domain: 'acme.test', provider: 'google', force: true },
      { resolver, now: new Date(NOW.getTime() + 60 * MINUTE) }
    );
    expect(resolver.calls.length).toBeGreaterThan(lookups);
  });

  it('re-checks a failing domain after ten minutes and keeps outreach intent', async () => {
    const failing = resolverFor({});
    const failed = await getSenderDeliverability(
      db,
      WORKSPACE,
      { domain: 'acme.test', provider: 'google', markOutreach: true },
      { resolver: failing, now: NOW }
    );
    expect(failed.status).toBe('fail');
    expect(failed.expiresAt).toBe(new Date(NOW.getTime() + 10 * MINUTE).toISOString());

    const fixed = await getSenderDeliverability(
      db,
      WORKSPACE,
      { domain: 'acme.test', provider: 'google' },
      {
        resolver: resolverFor(passingRecords('acme.test')),
        now: new Date(NOW.getTime() + 11 * MINUTE)
      }
    );
    expect(fixed.status).toBe('pass');
    const row = await db
      .prepare(
        'SELECT outreach_requested_at FROM email_deliverability_checks WHERE workspace_id=? AND domain=?'
      )
      .get<{ outreach_requested_at: string | null }>(WORKSPACE, 'acme.test');
    expect(new Date(String(row?.outreach_requested_at)).toISOString()).toBe(NOW.toISOString());
  });

  it('refreshes stale domains someone plans to send from and prunes abandoned ones', async () => {
    const failing = resolverFor({});
    const hourAgo = new Date(NOW.getTime() - 60 * MINUTE);
    await getSenderDeliverability(
      db,
      WORKSPACE,
      { domain: 'a.acme.test', provider: 'google', markOutreach: true },
      { resolver: failing, now: hourAgo }
    );
    await getSenderDeliverability(
      db,
      WORKSPACE,
      { domain: 'b.acme.test', provider: 'google' },
      { resolver: failing, now: hourAgo }
    );
    await getSenderDeliverability(
      db,
      WORKSPACE,
      { domain: 'c.acme.test', provider: 'google' },
      { resolver: failing, now: new Date(NOW.getTime() - 31 * 24 * 60 * MINUTE) }
    );

    const result = await refreshDueEmailDeliverability(db, {
      resolver: resolverFor(passingRecords('a.acme.test')),
      now: NOW
    });
    expect(result.refreshed).toBeGreaterThanOrEqual(1);
    expect(result.pruned).toBeGreaterThanOrEqual(1);
    expect((await readSenderDeliverability(db, WORKSPACE, 'a.acme.test', 'google'))?.status).toBe(
      'pass'
    );
    const untouched = await readSenderDeliverability(db, WORKSPACE, 'b.acme.test', 'google');
    expect(untouched?.status).toBe('fail');
    expect(untouched?.checkedAt).toBe(hourAgo.toISOString());
    expect(await readSenderDeliverability(db, WORKSPACE, 'c.acme.test', 'google')).toBeNull();
  });

  it('tries the owner DKIM selector first when the scheduled refresh re-checks a domain', async () => {
    const hourAgo = new Date(NOW.getTime() - 60 * MINUTE);
    await getSenderDeliverability(
      db,
      WORKSPACE,
      { domain: 'acme.test', provider: 'google', markOutreach: true },
      { resolver: resolverFor({}), now: hourAgo }
    );
    await db
      .prepare(
        `INSERT INTO email_dkim_selectors (workspace_id,domain,selector,updated_by_user_id,updated_at)
         VALUES (?,?,?,NULL,?::timestamptz)`
      )
      .run(WORKSPACE, 'acme.test', 'zmail', hourAgo.toISOString());
    const resolver = resolverFor({
      ...passingRecords('acme.test'),
      'zmail._domainkey.acme.test': [DKIM]
    });

    await refreshDueEmailDeliverability(db, { resolver, now: NOW });

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
});

describe('deliverability deadlines', () => {
  it('answers unknown when DNS does not answer in time and keeps outreach intent', async () => {
    const started = Date.now();
    const result = await getSenderDeliverability(
      db,
      WORKSPACE,
      { domain: 'acme.test', provider: 'google', markOutreach: true },
      { resolver: slowResolverFor({}, ['acme.test']), now: NOW, deadlineMs: 50 }
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.status).toBe('unknown');
    expect(result.blockers).toEqual([]);
    expect(result.spf.status).toBe('unknown');
    expect(result.spf.detail).toMatch(/rechecking/);
    expect(result.expiresAt).toBe(new Date(NOW.getTime() + 5 * MINUTE).toISOString());
    const row = await db
      .prepare(
        'SELECT status,outreach_requested_at FROM email_deliverability_checks WHERE workspace_id=? AND domain=?'
      )
      .get<{ status: string; outreach_requested_at: string | null }>(WORKSPACE, 'acme.test');
    expect(row?.status).toBe('unknown');
    expect(new Date(String(row?.outreach_requested_at)).toISOString()).toBe(NOW.toISOString());
  });

  it('keeps a fresh cached answer when a forced re-check times out', async () => {
    await getSenderDeliverability(
      db,
      WORKSPACE,
      { domain: 'acme.test', provider: 'google' },
      { resolver: resolverFor(passingRecords('acme.test')), now: NOW }
    );
    const result = await getSenderDeliverability(
      db,
      WORKSPACE,
      { domain: 'acme.test', provider: 'google', force: true },
      {
        resolver: slowResolverFor({}, ['acme.test']),
        now: new Date(NOW.getTime() + MINUTE),
        deadlineMs: 50
      }
    );
    expect(result.status).toBe('pass');
    expect(result.checkedAt).toBe(NOW.toISOString());
  });

  it('does not start a domain the sweep budget cannot finish; it stays due', async () => {
    const failing = resolverFor({});
    for (const [domain, minutesAgo] of [
      ['a.acme.test', 60],
      ['b.acme.test', 50]
    ] as const) {
      await getSenderDeliverability(
        db,
        WORKSPACE,
        { domain, provider: 'google', markOutreach: true },
        { resolver: failing, now: new Date(NOW.getTime() - minutesAgo * MINUTE) }
      );
    }
    const started = Date.now();
    const result = await refreshDueEmailDeliverability(db, {
      resolver: slowResolverFor(passingRecords('b.acme.test'), ['a.acme.test']),
      now: NOW,
      deadlineMs: 150,
      domainDeadlineMs: 100
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.refreshed).toBe(1);
    // a's OWN deadline fired: honestly unknown.
    expect((await readSenderDeliverability(db, WORKSPACE, 'a.acme.test', 'google'))?.status).toBe(
      'unknown'
    );
    // b was never started: untouched and still due.
    const waiting = await readSenderDeliverability(db, WORKSPACE, 'b.acme.test', 'google');
    expect(waiting?.status).toBe('fail');
    expect(waiting?.checkedAt).toBe(new Date(NOW.getTime() - 50 * MINUTE).toISOString());
    expect(Date.parse(waiting!.expiresAt)).toBeLessThanOrEqual(NOW.getTime());
  });

  it('never lets a timed-out sweep result replace a newer answer', async () => {
    await getSenderDeliverability(
      db,
      WORKSPACE,
      { domain: 'acme.test', provider: 'google', markOutreach: true },
      { resolver: resolverFor({}), now: new Date(NOW.getTime() - 60 * MINUTE) }
    );
    const later = new Date(NOW.getTime() + 20_000);
    let request: Promise<unknown> | null = null;
    const resolver: DnsResolver = {
      resolveTxt() {
        // A request re-checks the same domain while the sweep's lookup hangs.
        request ??= getSenderDeliverability(
          db,
          WORKSPACE,
          { domain: 'acme.test', provider: 'google', force: true },
          { resolver: resolverFor(passingRecords('acme.test')), now: later }
        );
        return new Promise<string[][]>(() => undefined);
      }
    };
    await refreshDueEmailDeliverability(db, {
      resolver,
      now: NOW,
      deadlineMs: 10_000,
      domainDeadlineMs: 300
    });
    await request;
    const row = await readSenderDeliverability(db, WORKSPACE, 'acme.test', 'google');
    expect(row?.status).toBe('pass');
    expect(row?.checkedAt).toBe(later.toISOString());
  });

  it('never moves checked_at backwards', async () => {
    const later = new Date(NOW.getTime() + 10 * MINUTE);
    await getSenderDeliverability(
      db,
      WORKSPACE,
      { domain: 'acme.test', provider: 'google' },
      { resolver: resolverFor(passingRecords('acme.test')), now: later }
    );
    const older = await getSenderDeliverability(
      db,
      WORKSPACE,
      { domain: 'acme.test', provider: 'google', force: true },
      { resolver: resolverFor({}), now: NOW }
    );
    expect(older.status).toBe('pass');
    expect(older.checkedAt).toBe(later.toISOString());
  });

  it('leaves the sweep to the replica holding its lock', async () => {
    await getSenderDeliverability(
      db,
      WORKSPACE,
      { domain: 'acme.test', provider: 'google', markOutreach: true },
      { resolver: resolverFor({}), now: new Date(NOW.getTime() - 60 * MINUTE) }
    );
    const [namespace, key] = DELIVERABILITY_SWEEP_LOCK;
    await db.withConnection('test-sweep-lock', async (holder) => {
      await holder.query('SELECT pg_advisory_lock(hashtext($1), hashtext($2))', [namespace, key]);
      try {
        const result = await refreshDueEmailDeliverability(db, {
          resolver: resolverFor(passingRecords('acme.test')),
          now: NOW
        });
        expect(result.refreshed).toBe(0);
      } finally {
        await holder.query('SELECT pg_advisory_unlock(hashtext($1), hashtext($2))', [
          namespace,
          key
        ]);
      }
    });
    expect((await readSenderDeliverability(db, WORKSPACE, 'acme.test', 'google'))?.status).toBe(
      'fail'
    );
  });

  it('stops writing once the worker starts draining', async () => {
    for (const [domain, minutesAgo] of [
      ['a.acme.test', 60],
      ['b.acme.test', 50],
      ['c.acme.test', 40]
    ] as const) {
      await getSenderDeliverability(
        db,
        WORKSPACE,
        { domain, provider: 'google', markOutreach: true },
        { resolver: resolverFor({}), now: new Date(NOW.getTime() - minutesAgo * MINUTE) }
      );
    }
    const answers = resolverFor({
      ...passingRecords('a.acme.test'),
      ...passingRecords('b.acme.test'),
      ...passingRecords('c.acme.test')
    });
    let draining = false;
    const resolver: DnsResolver = {
      resolveTxt(name: string) {
        // The drain begins while b is being checked.
        if (name.endsWith('b.acme.test')) draining = true;
        return answers.resolveTxt(name);
      }
    };
    const result = await refreshDueEmailDeliverability(db, {
      resolver,
      now: NOW,
      shouldStop: () => draining
    });
    expect(result.refreshed).toBe(1);
    expect((await readSenderDeliverability(db, WORKSPACE, 'a.acme.test', 'google'))?.status).toBe(
      'pass'
    );
    expect((await readSenderDeliverability(db, WORKSPACE, 'b.acme.test', 'google'))?.status).toBe(
      'fail'
    );
    expect((await readSenderDeliverability(db, WORKSPACE, 'c.acme.test', 'google'))?.status).toBe(
      'fail'
    );
    expect(answers.calls.some((name) => name.endsWith('c.acme.test'))).toBe(false);
  });

  it('reports unknown, never a stale pass, when a re-check times out', async () => {
    const dayAgo = new Date(NOW.getTime() - 25 * 60 * MINUTE);
    for (const domain of ['req.acme.test', 'sweep.acme.test']) {
      await getSenderDeliverability(
        db,
        WORKSPACE,
        { domain, provider: 'google', markOutreach: true },
        { resolver: resolverFor(passingRecords(domain)), now: dayAgo }
      );
    }
    const viaRequest = await getSenderDeliverability(
      db,
      WORKSPACE,
      { domain: 'req.acme.test', provider: 'google' },
      {
        resolver: slowResolverFor({}, ['req.acme.test']),
        now: NOW,
        deadlineMs: 20,
        domainDeadlineMs: 50
      }
    );
    expect(viaRequest.status).toBe('unknown');
    await refreshDueEmailDeliverability(db, {
      resolver: slowResolverFor({}, ['sweep.acme.test']),
      now: NOW,
      domainDeadlineMs: 50
    });
    for (const domain of ['req.acme.test', 'sweep.acme.test']) {
      expect((await readSenderDeliverability(db, WORKSPACE, domain, 'google'))?.status).toBe(
        'unknown'
      );
    }
  });

  it('finishes a slow check in the background after the request stops waiting', async () => {
    const fast = resolverFor(passingRecords('acme.test'));
    const slow: DnsResolver = {
      async resolveTxt(name: string) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return fast.resolveTxt(name);
      }
    };
    const started = Date.now();
    const answer = await getSenderDeliverability(
      db,
      WORKSPACE,
      { domain: 'acme.test', provider: 'google' },
      { resolver: slow, now: NOW, deadlineMs: 20, domainDeadlineMs: 5_000 }
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(answer.status).toBe('unknown');
    await vi.waitFor(
      async () => {
        const row = await readSenderDeliverability(db, WORKSPACE, 'acme.test', 'google');
        expect(row?.status).toBe('pass');
      },
      { timeout: 3_000, interval: 25 }
    );
  });

  it('stores nothing from a background check whose own deadline fired', async () => {
    await getSenderDeliverability(
      db,
      WORKSPACE,
      { domain: 'acme.test', provider: 'google' },
      {
        resolver: slowResolverFor({}, ['acme.test']),
        now: NOW,
        deadlineMs: 20,
        domainDeadlineMs: 80
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    const row = await readSenderDeliverability(db, WORKSPACE, 'acme.test', 'google');
    expect(row?.spf.detail).toMatch(/rechecking/);
  });

  it('normalises the domain the same way for reads and writes', async () => {
    const resolver = resolverFor(passingRecords('acme.test'));
    await getSenderDeliverability(
      db,
      WORKSPACE,
      { domain: 'acme.test', provider: 'google' },
      { resolver, now: NOW }
    );
    const lookups = resolver.calls.length;
    const again = await getSenderDeliverability(
      db,
      WORKSPACE,
      { domain: ' Acme.Test. ', provider: 'google' },
      { resolver, now: NOW }
    );
    expect(again.domain).toBe('acme.test');
    expect(resolver.calls.length).toBe(lookups);
    expect((await readSenderDeliverability(db, WORKSPACE, 'acme.test.', 'google'))?.status).toBe(
      'pass'
    );
    await expect(
      getSenderDeliverability(db, WORKSPACE, { domain: ' . ', provider: 'google' }, { resolver })
    ).rejects.toThrow(/domain/i);
  });

  it('gives up on one hanging domain without starving the domains behind it', async () => {
    const failing = resolverFor({});
    for (const [domain, minutesAgo] of [
      ['b.acme.test', 50],
      ['c.acme.test', 40]
    ] as const) {
      await getSenderDeliverability(
        db,
        WORKSPACE,
        { domain, provider: 'google', markOutreach: true },
        { resolver: failing, now: new Date(NOW.getTime() - minutesAgo * MINUTE) }
      );
    }
    const result = await refreshDueEmailDeliverability(db, {
      resolver: slowResolverFor(passingRecords('c.acme.test'), ['b.acme.test']),
      now: NOW,
      deadlineMs: 10_000,
      domainDeadlineMs: 50
    });
    expect(result.refreshed).toBe(2);
    expect((await readSenderDeliverability(db, WORKSPACE, 'b.acme.test', 'google'))?.status).toBe(
      'unknown'
    );
    expect((await readSenderDeliverability(db, WORKSPACE, 'c.acme.test', 'google'))?.status).toBe(
      'pass'
    );
  });

  it('gives up on a provider that does not answer with the mailbox address', async () => {
    await insertConnection({ id: 'conn_gmail_slow', provider: 'gmail' });
    const [mailbox] = await listSendingMailboxes(db, WORKSPACE);
    nangoMock.get.mockImplementationOnce(() => new Promise(() => undefined));
    const started = Date.now();
    expect(await resolveMailboxAddress(db, WORKSPACE, mailbox!, { deadlineMs: 50 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
    const row = await db
      .prepare('SELECT mailbox_address FROM connections WHERE id=?')
      .get<{ mailbox_address: string | null }>('conn_gmail_slow');
    expect(row?.mailbox_address).toBeNull();
  });
});

describe('mailbox identity races', () => {
  it('does not restore the old address when the mailbox is re-authorized mid-read', async () => {
    await insertConnection({ id: 'conn_gmail_reauth', provider: 'gmail' });
    const [mailbox] = await listSendingMailboxes(db, WORKSPACE);
    nangoMock.get.mockImplementationOnce(async () => {
      await db
        .prepare('UPDATE connections SET mailbox_address=NULL, updated_at=? WHERE id=?')
        .run(new Date(NOW.getTime() + MINUTE).toISOString(), 'conn_gmail_reauth');
      return { data: { emailAddress: 'old-owner@acme.test' }, headers: {} };
    });
    expect(await resolveMailboxAddress(db, WORKSPACE, mailbox!)).toBeNull();
    const row = await db
      .prepare('SELECT mailbox_address FROM connections WHERE id=?')
      .get<{ mailbox_address: string | null }>('conn_gmail_reauth');
    expect(row?.mailbox_address).toBeNull();
  });

  it('asks the provider again when a cached snapshot was cleared since', async () => {
    await insertConnection({ id: 'conn_gmail_snapshot', provider: 'gmail' });
    const [mailbox] = await listSendingMailboxes(db, WORKSPACE);
    nangoMock.get.mockResolvedValueOnce({ data: { emailAddress: 'new@acme.test' }, headers: {} });
    expect(
      await resolveMailboxAddress(db, WORKSPACE, { ...mailbox!, address: 'old-owner@acme.test' })
    ).toBe('new@acme.test');
  });
});

describe('sending mailbox identity', () => {
  it('lists live mailboxes and caches the provider-verified address', async () => {
    await insertConnection({ id: 'conn_gmail_live', provider: 'gmail' });
    await insertConnection({
      id: 'conn_ms_live',
      provider: 'microsoft',
      updatedAt: new Date(NOW.getTime() - MINUTE).toISOString()
    });
    await insertConnection({ id: 'conn_demo', provider: 'gmail', isDemo: 1 });
    await insertConnection({ id: 'conn_gone', provider: 'gmail', status: 'disconnected' });

    const mailboxes = await listSendingMailboxes(db, WORKSPACE);
    expect(mailboxes.map((mailbox) => [mailbox.connectionId, mailbox.providerKey])).toEqual([
      ['conn_gmail_live', 'google'],
      ['conn_ms_live', 'microsoft']
    ]);
    expect(mailboxes.every((mailbox) => mailbox.address === null)).toBe(true);

    nangoMock.get.mockResolvedValueOnce({
      data: { emailAddress: 'Founder@Acme.test' },
      headers: {}
    });
    expect(await resolveMailboxAddress(db, WORKSPACE, mailboxes[0]!)).toBe('founder@acme.test');
    expect(nangoMock.get.mock.calls[0]?.[0]).toMatchObject({
      endpoint: '/gmail/v1/users/me/profile',
      providerConfigKey: 'trevra-gmail',
      connectionId: 'conn_gmail_live-external'
    });

    nangoMock.get.mockResolvedValueOnce({
      data: { mail: null, userPrincipalName: 'ops@acme.test' },
      headers: {}
    });
    expect(await resolveMailboxAddress(db, WORKSPACE, mailboxes[1]!)).toBe('ops@acme.test');
    expect(nangoMock.get.mock.calls[1]?.[0]).toMatchObject({
      endpoint: '/v1.0/me',
      params: { $select: 'mail,userPrincipalName' }
    });

    const cached = await listSendingMailboxes(db, WORKSPACE);
    expect(cached.map((mailbox) => mailbox.address)).toEqual([
      'founder@acme.test',
      'ops@acme.test'
    ]);
    expect(await resolveMailboxAddress(db, WORKSPACE, cached[0]!)).toBe('founder@acme.test');
    expect(nangoMock.get).toHaveBeenCalledTimes(2);
  });

  it('stores nothing when the provider answer is not an address', async () => {
    await insertConnection({ id: 'conn_gmail_odd', provider: 'gmail' });
    const [mailbox] = await listSendingMailboxes(db, WORKSPACE);
    nangoMock.get.mockResolvedValueOnce({ data: { emailAddress: 'not an address' }, headers: {} });
    expect(await resolveMailboxAddress(db, WORKSPACE, mailbox!)).toBeNull();
    nangoMock.get.mockRejectedValueOnce(Object.assign(new Error('HTTP 401'), { status: 401 }));
    expect(await resolveMailboxAddress(db, WORKSPACE, mailbox!)).toBeNull();
    const row = await db
      .prepare('SELECT mailbox_address FROM connections WHERE id=?')
      .get<{ mailbox_address: string | null }>('conn_gmail_odd');
    expect(row?.mailbox_address).toBeNull();
  });
});
