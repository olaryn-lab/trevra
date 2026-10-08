import { describe, expect, it, vi } from 'vitest';
import {
  ZohoMailError,
  parseZohoHeaders,
  pickZohoAccount,
  pickZohoFolderId,
  readZohoAccount,
  readZohoSentMessageId,
  sendZohoMessage,
  zohoHeaderValue,
  zohoMessageId,
  type ZohoNango
} from './zoho-mail.js';

const CONNECTION = { providerConfigKey: 'trevra-zoho-mail', connectionId: 'zoho-external' };
const ACCOUNT = {
  accountId: '1000000001',
  type: 'ZOHO_ACCOUNT',
  primaryEmailAddress: 'Founder@Acme.test'
};

function fakeNango(
  get: (config: { endpoint: string }) => Promise<unknown>,
  post: (config: { endpoint: string }) => Promise<unknown> = async () => ({ data: {} })
) {
  const nango = { get: vi.fn(get), post: vi.fn(post) };
  return { nango, client: nango as unknown as ZohoNango };
}

describe('Zoho Mail response parsing', () => {
  it('picks exactly one Zoho account and lowercases its address', () => {
    expect(pickZohoAccount({ data: [ACCOUNT] })).toEqual({
      accountId: '1000000001',
      address: 'founder@acme.test'
    });
    expect(pickZohoAccount({ data: [{ ...ACCOUNT, accountId: 1000000001 }] })?.accountId).toBe(
      '1000000001'
    );
    expect(
      pickZohoAccount({
        data: [{ ...ACCOUNT, primaryEmailAddress: undefined, mailboxAddress: 'a@acme.test' }]
      })
    ).toEqual({ accountId: '1000000001', address: 'a@acme.test' });
  });

  it('refuses an ambiguous, empty or foreign account list', () => {
    expect(pickZohoAccount({ data: [ACCOUNT, { ...ACCOUNT, accountId: '2' }] })).toBeNull();
    expect(pickZohoAccount({ data: [] })).toBeNull();
    expect(pickZohoAccount({})).toBeNull();
    expect(pickZohoAccount({ data: [{ ...ACCOUNT, type: 'POP_ACCOUNT' }] })).toBeNull();
    expect(
      pickZohoAccount({ data: [{ ...ACCOUNT, primaryEmailAddress: 'not-an-address' }] })
    ).toBeNull();
    // A POP account beside the Zoho account does not make it ambiguous.
    expect(
      pickZohoAccount({ data: [ACCOUNT, { ...ACCOUNT, accountId: '3', type: 'POP_ACCOUNT' }] })
    ).toEqual({ accountId: '1000000001', address: 'founder@acme.test' });
  });

  it('finds the inbox or sent folder by type before name', () => {
    const folders = {
      data: [
        { folderId: '11', folderName: 'Sent', folderType: 'Inbox' },
        { folderId: '12', folderName: 'Inbox', folderType: 'Sent' },
        { folderId: '13', folderName: 'Drafts', folderType: 'Drafts' }
      ]
    };
    expect(pickZohoFolderId(folders, 'inbox')).toBe('11');
    expect(pickZohoFolderId(folders, 'sent')).toBe('12');
    expect(pickZohoFolderId({ data: [{ folderId: 21, folderName: 'Sent' }] }, 'sent')).toBe('21');
    expect(pickZohoFolderId({ data: [] }, 'inbox')).toBeNull();
    expect(pickZohoFolderId('nope', 'inbox')).toBeNull();
  });

  it('parses a raw header block, a headerContent block and a name-to-value map', () => {
    const block =
      'Message-ID: <abc@mx.zoho.test>\r\nSubject: Long\r\n subject line\r\nFrom: Ada <ada@prospect.test>';
    const fromString = parseZohoHeaders({ data: block });
    expect(zohoHeaderValue(fromString, 'subject')).toBe('Long subject line');
    expect(zohoMessageId(fromString)).toBe('<abc@mx.zoho.test>');

    const fromContent = parseZohoHeaders({ data: { headerContent: block } });
    expect(zohoHeaderValue(fromContent, 'FROM')).toBe('Ada <ada@prospect.test>');

    const fromMap = parseZohoHeaders({
      data: { 'Message-Id': ['<def@mx.zoho.test>'], Subject: 'Hi', Ignored: 7 }
    });
    expect(zohoMessageId(fromMap)).toBe('<def@mx.zoho.test>');
    expect(zohoHeaderValue(fromMap, 'ignored')).toBeNull();

    expect(parseZohoHeaders({})).toEqual([]);
    expect(zohoMessageId([{ name: 'Message-ID', value: 'no brackets' }])).toBeNull();
  });
});

describe('Zoho Mail calls', () => {
  it('reads the one account through the proxy', async () => {
    const { nango, client } = fakeNango(async () => ({ data: { data: [ACCOUNT] } }));
    await expect(readZohoAccount(client, CONNECTION)).resolves.toEqual({
      accountId: '1000000001',
      address: 'founder@acme.test'
    });
    expect(nango.get).toHaveBeenCalledWith({
      endpoint: '/api/accounts',
      providerConfigKey: 'trevra-zoho-mail',
      connectionId: 'zoho-external',
      retries: 3
    });
  });

  it('refuses to name a sender when the token sees two Zoho accounts', async () => {
    const { client } = fakeNango(async () => ({
      data: { data: [ACCOUNT, { ...ACCOUNT, accountId: '2', primaryEmailAddress: 'b@acme.test' }] }
    }));
    await expect(readZohoAccount(client, CONNECTION)).rejects.toBeInstanceOf(ZohoMailError);
  });

  it('sends plain text once, with no retry, and returns the message id', async () => {
    const { nango, client } = fakeNango(
      async () => ({ data: {} }),
      async () => ({ data: { status: { code: 200 }, data: { messageId: 1777 } } })
    );
    await expect(
      sendZohoMessage(client, CONNECTION, {
        accountId: '1000000001',
        fromAddress: 'founder@acme.test',
        toAddress: 'maya@prospect.test',
        subject: 'Quick question, Maya',
        content: 'Hi Maya,\n\nWould you be open to a short conversation?'
      })
    ).resolves.toEqual({ messageId: '1777' });
    expect(nango.post).toHaveBeenCalledWith({
      endpoint: '/api/accounts/1000000001/messages',
      providerConfigKey: 'trevra-zoho-mail',
      connectionId: 'zoho-external',
      retries: 0,
      data: {
        fromAddress: 'founder@acme.test',
        toAddress: 'maya@prospect.test',
        subject: 'Quick question, Maya',
        content: 'Hi Maya,\n\nWould you be open to a short conversation?',
        mailFormat: 'plaintext',
        encoding: 'UTF-8'
      }
    });

    const { client: silent } = fakeNango(
      async () => ({ data: {} }),
      async () => ({ data: { status: { code: 200 } } })
    );
    await expect(
      sendZohoMessage(silent, CONNECTION, {
        accountId: '1',
        fromAddress: 'a@acme.test',
        toAddress: 'b@prospect.test',
        subject: 's',
        content: 'c'
      })
    ).resolves.toEqual({ messageId: null });
  });

  it('reads the sent Message-ID back from the Sent folder header', async () => {
    const { nango, client } = fakeNango(async ({ endpoint }) => {
      if (endpoint === '/api/accounts/1000000001/folders') {
        return { data: { data: [{ folderId: '9', folderName: 'Sent', folderType: 'Sent' }] } };
      }
      if (endpoint === '/api/accounts/1000000001/folders/9/messages/1777/header') {
        return { data: { data: { headerContent: 'Message-ID: <zoho-1777@mx.zoho.test>' } } };
      }
      throw new Error(`unexpected ${endpoint}`);
    });
    await expect(
      readZohoSentMessageId(client, CONNECTION, { accountId: '1000000001', messageId: '1777' })
    ).resolves.toBe('<zoho-1777@mx.zoho.test>');
    expect(nango.get).toHaveBeenCalledTimes(2);
  });

  it('returns null, never throws, when the read-back fails, finds no folder or never answers', async () => {
    const failing = fakeNango(async () => {
      throw Object.assign(new Error('HTTP 500'), { status: 500 });
    });
    await expect(
      readZohoSentMessageId(failing.client, CONNECTION, { accountId: '1', messageId: '2' })
    ).resolves.toBeNull();

    const noFolder = fakeNango(async () => ({ data: { data: [] } }));
    await expect(
      readZohoSentMessageId(noFolder.client, CONNECTION, { accountId: '1', messageId: '2' })
    ).resolves.toBeNull();

    const hanging = fakeNango(() => new Promise(() => undefined));
    await expect(
      readZohoSentMessageId(hanging.client, CONNECTION, { accountId: '1', messageId: '2' }, 10)
    ).resolves.toBeNull();
  });
});
