import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nangoMock = vi.hoisted(() => ({
  get: vi.fn(async (_config: Record<string, unknown>) => ({ data: {} as unknown, headers: {} })),
  post: vi.fn(async (_config: Record<string, unknown>) => ({ data: {} as unknown, headers: {} }))
}));
vi.mock('@nangohq/node', () => ({
  Nango: class {
    get = nangoMock.get;
    post = nangoMock.post;
  }
}));

import { openDatabase, type Db } from '../db.js';
import {
  defaultConnectSessionIntegrations,
  executeConnectedAction,
  listAvailableIntegrations
} from '../integration-service.js';
import { getEmailChannelStatus } from './channel.js';
import type { DnsResolver } from './deliverability.js';
import { listSendingMailboxes, resolveMailboxAddress } from './mailbox-address.js';
import { ZOHO_OUTREACH_DAILY_CAP } from './zoho-mail.js';

const WORKSPACE = 'ws_email_zoho_mailbox';
const NOW = new Date('2026-10-07T09:00:00.000Z');
const ACCOUNT = {
  accountId: '1000000001',
  type: 'ZOHO_ACCOUNT',
  primaryEmailAddress: 'Founder@Acme.test'
};
const noDns: DnsResolver = {
  async resolveTxt(name: string) {
    throw Object.assign(new Error(`ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
  }
};
let db: Db;

async function insertConnection(
  id: string,
  provider: 'zoho-mail' | 'gmail' | 'microsoft',
  address: string | null,
  updatedAt = NOW
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO connections
       (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,
        mailbox_address,created_at,updated_at)
       VALUES (?,?,?,?,?,NULL,'connected',0,?,?,?)`
    )
    .run(
      id,
      WORKSPACE,
      provider,
      `trevra-${provider}`,
      `${id}-external`,
      address,
      NOW.toISOString(),
      updatedAt.toISOString()
    );
}

async function cachedAddress(id: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT mailbox_address FROM connections WHERE workspace_id=? AND id=?')
    .get<{ mailbox_address: string | null }>(WORKSPACE, id);
  return row?.mailbox_address ?? null;
}

beforeEach(async () => {
  vi.stubEnv('NANGO_API_KEY', 'test-nango-key');
  nangoMock.get.mockReset();
  nangoMock.get.mockResolvedValue({ data: {}, headers: {} });
  nangoMock.post.mockReset();
  nangoMock.post.mockResolvedValue({ data: { id: 'gmail-sent' }, headers: {} });
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Zoho mailbox', NOW.toISOString());
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

describe('Zoho Mail mailbox identity', () => {
  it('lists a connected Zoho Mail connection as a zoho sending mailbox', async () => {
    await insertConnection('conn_zoho', 'zoho-mail', null);
    expect(await listSendingMailboxes(db, WORKSPACE)).toEqual([
      {
        connectionId: 'conn_zoho',
        provider: 'zoho-mail',
        providerKey: 'zoho',
        displayName: null,
        address: null,
        providerConfigKey: 'trevra-zoho-mail',
        externalConnectionId: 'conn_zoho-external'
      }
    ]);
  });

  it('reads the one Zoho account address through Nango and caches it lowercase', async () => {
    await insertConnection('conn_zoho', 'zoho-mail', null);
    nangoMock.get.mockResolvedValueOnce({ data: { data: [ACCOUNT] }, headers: {} });
    const [mailbox] = await listSendingMailboxes(db, WORKSPACE);
    expect(await resolveMailboxAddress(db, WORKSPACE, mailbox!)).toBe('founder@acme.test');
    expect(nangoMock.get).toHaveBeenCalledWith({
      endpoint: '/api/accounts',
      providerConfigKey: 'trevra-zoho-mail',
      connectionId: 'conn_zoho-external',
      retries: 3
    });
    expect(await cachedAddress('conn_zoho')).toBe('founder@acme.test');
  });

  it('caches no address when the token sees two Zoho accounts', async () => {
    await insertConnection('conn_zoho', 'zoho-mail', null);
    nangoMock.get.mockResolvedValueOnce({
      data: {
        data: [ACCOUNT, { ...ACCOUNT, accountId: '2', primaryEmailAddress: 'other@acme.test' }]
      },
      headers: {}
    });
    const [mailbox] = await listSendingMailboxes(db, WORKSPACE);
    expect(await resolveMailboxAddress(db, WORKSPACE, mailbox!)).toBeNull();
    expect(await cachedAddress('conn_zoho')).toBeNull();
  });

  it('offers Zoho Mail in the catalog and in the Connect allow-list', async () => {
    const integrations = await listAvailableIntegrations(db, WORKSPACE);
    expect(integrations.find((item) => item.provider === 'zoho-mail')).toMatchObject({
      key: 'trevra-zoho-mail',
      name: 'Zoho Mail',
      category: 'communication',
      mode: 'oauth'
    });
    expect(defaultConnectSessionIntegrations()).toContain('trevra-zoho-mail');
    vi.stubEnv('NANGO_ZOHO_MAIL_INTEGRATION', 'zoho-mail-eu');
    expect(defaultConnectSessionIntegrations()).toContain('zoho-mail-eu');
  });

  it('reports the reply-only unsubscribe and the daily cap on Zoho rows only', async () => {
    await insertConnection(
      'conn_zoho',
      'zoho-mail',
      'founder@acme.test',
      new Date(NOW.getTime() + 1000)
    );
    await insertConnection('conn_gmail', 'gmail', 'founder@beta.test');
    await insertConnection(
      'conn_ms',
      'microsoft',
      'founder@gamma.test',
      new Date(NOW.getTime() - 1000)
    );
    const status = await getEmailChannelStatus(db, WORKSPACE, { resolver: noDns, now: NOW });
    expect(
      status.mailboxes.map(({ connectionId, unsubscribeMode, dailyCap }) => ({
        connectionId,
        unsubscribeMode,
        dailyCap
      }))
    ).toEqual([
      {
        connectionId: 'conn_zoho',
        unsubscribeMode: 'footer_and_reply',
        dailyCap: ZOHO_OUTREACH_DAILY_CAP
      },
      { connectionId: 'conn_gmail', unsubscribeMode: 'list_unsubscribe_headers', dailyCap: null },
      { connectionId: 'conn_ms', unsubscribeMode: 'list_unsubscribe_headers', dailyCap: null }
    ]);
  });

  it('reports the effective Zoho daily cap when the operator limit is lower', async () => {
    await insertConnection('conn_zoho', 'zoho-mail', 'founder@acme.test');
    await db
      .prepare(
        `INSERT INTO linkedin_campaign_mailbox_settings (workspace_id,connection_id,daily_limit)
         VALUES (?,'conn_zoho',5)`
      )
      .run(WORKSPACE);
    const status = await getEmailChannelStatus(db, WORKSPACE, { resolver: noDns, now: NOW });
    expect(status.mailboxes.map(({ dailyCap }) => dailyCap)).toEqual([5]);
  });

  describe('unbound send fallback', () => {
    const unbound = {
      type: 'email_draft',
      recipient: 'lead@prospect.test',
      subject: 'Hello',
      body: 'Hi there',
      structured_payload_json: JSON.stringify({ threaded: false }),
      payload_hash: 'unbound-key'
    };

    it('sends through the Gmail connection even when a newer Zoho one exists', async () => {
      await insertConnection('conn_gmail', 'gmail', 'founder@beta.test');
      await insertConnection(
        'conn_zoho',
        'zoho-mail',
        'founder@acme.test',
        new Date(NOW.getTime() + 1000)
      );
      const result = await executeConnectedAction(db, WORKSPACE, unbound);
      expect(result.provider).toBe('gmail');
      expect(nangoMock.post).toHaveBeenCalledTimes(1);
      expect(nangoMock.post.mock.calls[0]?.[0]).toMatchObject({
        providerConfigKey: 'trevra-gmail',
        connectionId: 'conn_gmail-external'
      });
    });

    it('never sends through a lone Zoho connection without an approved binding', async () => {
      await insertConnection('conn_zoho', 'zoho-mail', 'founder@acme.test');
      await expect(executeConnectedAction(db, WORKSPACE, unbound)).rejects.toThrow(
        /Connect Gmail or Microsoft 365/
      );
      expect(nangoMock.post).not.toHaveBeenCalled();
    });
  });
});
