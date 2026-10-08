import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nangoMock = vi.hoisted(() => ({
  get: vi.fn(async (_config: { endpoint: string }): Promise<unknown> => ({
    data: {},
    headers: {}
  })),
  post: vi.fn(async (_config: { endpoint: string }): Promise<unknown> => ({
    data: {},
    headers: {}
  }))
}));
vi.mock('@nangohq/node', () => ({
  Nango: class {
    get = nangoMock.get;
    post = nangoMock.post;
  }
}));

import { openDatabase, type Db } from '../db.js';
import { executeConnectedAction } from '../integration-service.js';
import { OUTREACH_REPLY_OPT_OUT_SENTENCE } from './unsubscribe-policy.js';

const WORKSPACE = 'ws_email_zoho_send';
const ZOHO = 'conn_email_zoho_send';
const GMAIL = 'conn_email_zoho_send_gmail';
const NOW = new Date('2026-10-07T09:00:00.000Z');
const ACCOUNT = {
  accountId: '1000000001',
  type: 'ZOHO_ACCOUNT',
  primaryEmailAddress: 'founder@acme.test'
};
const ZOHO_OUTREACH = {
  deliveryPurpose: 'outreach',
  deliverySourceType: 'email_outreach',
  deliverySourceId: 'eo_zoho_send_1',
  unsubscribeMode: 'footer_and_reply',
  requireListUnsubscribe: false,
  // execution.ts passes the approved metadata through unchanged.
  intent: 'email-outreach'
};
// An approved Zoho outreach body ends with the reply-to-unsubscribe footer line.
const BODY = `Hi Maya,\n\nWould you be open to a short conversation?\n\n${OUTREACH_REPLY_OPT_OUT_SENTENCE}`;
let db: Db;

function zohoProvider(
  options: { accounts?: unknown[]; header?: unknown; send?: () => Promise<unknown> } = {}
) {
  nangoMock.get.mockImplementation(async ({ endpoint }) => {
    if (endpoint === '/api/accounts')
      return { data: { data: options.accounts ?? [ACCOUNT] }, headers: {} };
    if (endpoint === '/api/accounts/1000000001/folders') {
      return {
        data: { data: [{ folderId: '9', folderName: 'Sent', folderType: 'Sent' }] },
        headers: {}
      };
    }
    if (endpoint === '/api/accounts/1000000001/folders/9/messages/1777/header') {
      if (options.header instanceof Error) throw options.header;
      return {
        data: options.header ?? { data: { headerContent: 'Message-ID: <zoho-1777@mx.zoho.test>' } },
        headers: {}
      };
    }
    throw new Error(`unexpected GET ${endpoint}`);
  });
  nangoMock.post.mockImplementation(
    options.send ??
      (async () => ({ data: { status: { code: 200 }, data: { messageId: '1777' } }, headers: {} }))
  );
}

function send(
  overrides: {
    connectionId?: string;
    payload?: Record<string, unknown>;
    key?: string;
    body?: string;
    bound?: boolean;
  } = {}
) {
  return executeConnectedAction(db, WORKSPACE, {
    type: 'email_draft',
    connection_id: overrides.connectionId ?? ZOHO,
    ...(overrides.bound === false ? {} : { require_connection_id: true }),
    recipient: 'maya@prospect.test',
    subject: 'Quick question, Maya',
    body: overrides.body ?? BODY,
    structured_payload_json: JSON.stringify(overrides.payload ?? ZOHO_OUTREACH),
    payload_hash: overrides.key ?? 'zoho-send-key-0001'
  });
}

async function deliveries() {
  return db
    .prepare(
      `SELECT status,provider,external_ref,internet_message_id,connection_id FROM gtm_deliveries
       WHERE workspace_id=? ORDER BY created_at`
    )
    .all<Record<string, unknown>>(WORKSPACE);
}

beforeEach(async () => {
  vi.stubEnv('NANGO_API_KEY', 'test-nango-key');
  nangoMock.get.mockReset();
  nangoMock.post.mockReset();
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'Zoho send', NOW.toISOString());
  for (const [id, provider] of [
    [ZOHO, 'zoho-mail'],
    [GMAIL, 'gmail']
  ] as const) {
    await db
      .prepare(
        `INSERT INTO connections
         (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,
          mailbox_address,created_at,updated_at)
         VALUES (?,?,?,?,?,NULL,'connected',0,'founder@acme.test',?,?)`
      )
      .run(
        id,
        WORKSPACE,
        provider,
        `trevra-${provider}`,
        `${provider}-external`,
        NOW.toISOString(),
        NOW.toISOString()
      );
  }
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

describe('Zoho Mail outreach send', () => {
  it('sends the exact approved text once from the approved address and records the delivery', async () => {
    zohoProvider();
    await expect(send()).resolves.toEqual({ provider: 'zoho-mail', externalRef: '1777' });
    expect(nangoMock.post).toHaveBeenCalledTimes(1);
    expect(nangoMock.post.mock.calls[0]![0]).toEqual({
      endpoint: '/api/accounts/1000000001/messages',
      providerConfigKey: 'trevra-zoho-mail',
      connectionId: 'zoho-mail-external',
      retries: 0,
      data: {
        fromAddress: 'founder@acme.test',
        toAddress: 'maya@prospect.test',
        subject: 'Quick question, Maya',
        content: BODY,
        mailFormat: 'plaintext',
        encoding: 'UTF-8'
      }
    });
    expect(JSON.stringify(nangoMock.post.mock.calls)).not.toContain('List-Unsubscribe');
    expect(await deliveries()).toEqual([
      {
        status: 'sent',
        provider: 'zoho-mail',
        external_ref: '1777',
        internet_message_id: '<zoho-1777@mx.zoho.test>',
        connection_id: ZOHO
      }
    ]);
    // A replay of the same approval never sends again.
    await expect(send()).resolves.toEqual({ provider: 'zoho-mail', externalRef: '1777' });
    expect(nangoMock.post).toHaveBeenCalledTimes(1);
  });

  it('keeps the sent delivery with no Message-ID when the read-back fails', async () => {
    zohoProvider({ header: Object.assign(new Error('HTTP 500'), { status: 500 }) });
    await send();
    expect(await deliveries()).toEqual([
      expect.objectContaining({ status: 'sent', external_ref: '1777', internet_message_id: null })
    ]);
  });

  it('refuses Zoho outreach approved with List-Unsubscribe or without reply mode, before any delivery row', async () => {
    zohoProvider();
    await expect(
      send({
        payload: {
          ...ZOHO_OUTREACH,
          requireListUnsubscribe: true,
          unsubscribeMode: 'list_unsubscribe_headers'
        }
      })
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/cannot send the one-click/)
    });
    await expect(
      send({
        payload: {
          deliveryPurpose: 'outreach',
          deliverySourceType: 'email_outreach',
          deliverySourceId: 'x'
        }
      })
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/not approved for Zoho Mail/)
    });
    expect(nangoMock.post).not.toHaveBeenCalled();
    expect(nangoMock.get).not.toHaveBeenCalled();
    expect(await deliveries()).toEqual([]);
  });

  it('refuses Gmail outreach approved in reply-only mode, before any delivery row', async () => {
    await expect(send({ connectionId: GMAIL })).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/only for Zoho Mail/)
    });
    expect(nangoMock.post).not.toHaveBeenCalled();
    expect(await deliveries()).toEqual([]);
  });

  it('refuses reply-to-unsubscribe on a Zoho send that is not approved email outreach, before any delivery row', async () => {
    zohoProvider();
    await expect(
      send({ payload: { ...ZOHO_OUTREACH, deliverySourceType: 'campaign_email' } })
    ).rejects.toMatchObject({
      status: 409,
      message: 'Reply-to-unsubscribe is allowed only for approved email outreach; nothing was sent.'
    });
    expect(nangoMock.post).not.toHaveBeenCalled();
    expect(nangoMock.get).not.toHaveBeenCalled();
    expect(await deliveries()).toEqual([]);
  });

  it('refuses reply-to-unsubscribe on email_outreach whose approval is not the outreach intent, before any delivery row', async () => {
    zohoProvider();
    const { intent: _intent, ...withoutIntent } = ZOHO_OUTREACH;
    for (const payload of [withoutIntent, { ...ZOHO_OUTREACH, intent: 'skill-draft' }]) {
      await expect(send({ payload })).rejects.toMatchObject({
        status: 409,
        message:
          'Reply-to-unsubscribe is allowed only for approved email outreach; nothing was sent.'
      });
    }
    expect(nangoMock.post).not.toHaveBeenCalled();
    expect(nangoMock.get).not.toHaveBeenCalled();
    expect(await deliveries()).toEqual([]);
  });

  it('sends nothing when the Zoho token now answers as another account or as two accounts', async () => {
    zohoProvider({ accounts: [{ ...ACCOUNT, primaryEmailAddress: 'someone@else.test' }] });
    await expect(send()).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/sends as a different address/)
    });
    zohoProvider({
      accounts: [ACCOUNT, { ...ACCOUNT, accountId: '2', primaryEmailAddress: 'b@acme.test' }]
    });
    await expect(
      send({
        key: 'zoho-send-key-0002',
        payload: { ...ZOHO_OUTREACH, deliverySourceId: 'eo_zoho_send_2' }
      })
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/exactly one Zoho mail account/)
    });
    expect(nangoMock.post).not.toHaveBeenCalled();
    // Nothing left Zoho, so both deliveries stay retryable.
    expect((await deliveries()).map((row) => row.status)).toEqual(['failed', 'failed']);
  });

  it('marks a rejected send failed and an ambiguous one uncertain', async () => {
    zohoProvider({
      send: async () => Promise.reject(Object.assign(new Error('HTTP 400'), { status: 400 }))
    });
    await expect(send()).rejects.toThrow('HTTP 400');
    zohoProvider({ send: async () => Promise.reject(new Error('socket hang up')) });
    await expect(
      send({
        key: 'zoho-send-key-0003',
        payload: { ...ZOHO_OUTREACH, deliverySourceId: 'eo_zoho_send_3' }
      })
    ).rejects.toThrow('socket hang up');
    expect((await deliveries()).map((row) => String(row.status)).sort()).toEqual([
      'failed',
      'uncertain'
    ]);
  });

  it('marks a 5xx or timed-out send uncertain, never failed, so it is not resent', async () => {
    zohoProvider({
      send: async () => Promise.reject(Object.assign(new Error('HTTP 502'), { status: 502 }))
    });
    await expect(send()).rejects.toThrow('HTTP 502');
    zohoProvider({
      send: async () =>
        Promise.reject(
          Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' })
        )
    });
    await expect(
      send({
        key: 'zoho-send-key-0004',
        payload: { ...ZOHO_OUTREACH, deliverySourceId: 'eo_zoho_send_4' }
      })
    ).rejects.toThrow('timeout');
    expect((await deliveries()).map((row) => row.status)).toEqual(['uncertain', 'uncertain']);
  });

  it('refuses a threaded or HTML Zoho send without calling the send endpoint', async () => {
    zohoProvider();
    await expect(
      send({ payload: { ...ZOHO_OUTREACH, threaded: true, threadExternalRef: 'zoho-earlier' } })
    ).rejects.toMatchObject({ status: 409 });
    expect(nangoMock.post).not.toHaveBeenCalled();
  });

  it('refuses an HTML-only or a follow-up-only Zoho send, leaving a failed delivery', async () => {
    zohoProvider();
    await expect(
      send({
        key: 'zoho-send-key-0005',
        payload: { ...ZOHO_OUTREACH, deliverySourceId: 'eo_zoho_send_5', htmlBody: '<p>x</p>' }
      })
    ).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/threading or HTML/) });
    await expect(
      send({
        key: 'zoho-send-key-0006',
        payload: {
          ...ZOHO_OUTREACH,
          deliverySourceId: 'eo_zoho_send_6',
          threaded: true,
          threadIdempotencyKey: 'k'
        }
      })
    ).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/threading or HTML/) });
    expect(nangoMock.post).not.toHaveBeenCalled();
    expect((await deliveries()).map((row) => row.status)).toEqual(['failed', 'failed']);
  });

  it('refuses a Zoho send not bound to the mailbox by approval, before any delivery row', async () => {
    zohoProvider();
    await expect(send({ bound: false })).rejects.toMatchObject({
      status: 409,
      message: 'Zoho Mail sends only outreach bound to it by approval; nothing was sent.'
    });
    expect(nangoMock.post).not.toHaveBeenCalled();
    expect(nangoMock.get).not.toHaveBeenCalled();
    expect(await deliveries()).toEqual([]);
  });

  it('refuses a Zoho body that does not end with the reply-to-unsubscribe line, before any delivery row', async () => {
    zohoProvider();
    await expect(
      send({ body: 'Hi Maya,\n\nWould you be open to a short conversation?' })
    ).rejects.toMatchObject({
      status: 409,
      message:
        'This Zoho Mail outreach does not end with the reply-to-unsubscribe line; nothing was sent. Prepare it again.'
    });
    expect(nangoMock.post).not.toHaveBeenCalled();
    expect(nangoMock.get).not.toHaveBeenCalled();
    expect(await deliveries()).toEqual([]);
  });

  it('records a send that returns no messageId with a zoho_ ref, no Message-ID and no read-back', async () => {
    zohoProvider({
      send: async () => ({ data: { status: { code: 200 }, data: {} }, headers: {} })
    });
    const result = await send();
    expect(result).toEqual({ provider: 'zoho-mail', externalRef: expect.stringMatching(/^zoho_/) });
    expect(nangoMock.post).toHaveBeenCalledTimes(1);
    // Only the pre-send account read; no Sent-folder or header read-back.
    expect(nangoMock.get.mock.calls.map((call) => call[0].endpoint)).toEqual(['/api/accounts']);
    expect(await deliveries()).toEqual([
      expect.objectContaining({
        status: 'sent',
        external_ref: result.externalRef,
        internet_message_id: null
      })
    ]);
  });
});
