import { describe, expect, it } from 'vitest';
import { headerValue } from '../../../nango-integrations/shared/inbound-email.js';
import {
  ZOHO_LIST_CEILING,
  ZOHO_LIST_PAGE_SIZE,
  ZOHO_MAX_MESSAGES_PER_RUN,
  mimeFromOriginalMessage,
  parseMimeMessage,
  parseZohoHeaders as syncParseZohoHeaders,
  pickZohoAccount as syncPickZohoAccount,
  pickZohoFolderId as syncPickZohoFolderId,
  zohoListEntries
} from '../../../nango-integrations/shared/zoho-mail.js';
import { parseZohoHeaders, pickZohoAccount, pickZohoFolderId } from './zoho-mail.js';

const ACCOUNTS: unknown[] = [
  {
    data: [
      { accountId: 1000000001, type: 'ZOHO_ACCOUNT', primaryEmailAddress: 'Founder@Acme.test' }
    ]
  },
  { data: [{ accountId: '1', type: 'ZOHO_ACCOUNT', mailboxAddress: 'founder@acme.test' }] },
  {
    data: [
      { accountId: '1', type: 'ZOHO_ACCOUNT', primaryEmailAddress: 'founder@acme.test' },
      { accountId: '2', type: 'ZOHO_ACCOUNT', primaryEmailAddress: 'other@acme.test' }
    ]
  },
  { data: [{ accountId: '3', type: 'POP_ACCOUNT', primaryEmailAddress: 'pop@acme.test' }] },
  { data: [{ accountId: '4', type: 'ZOHO_ACCOUNT', primaryEmailAddress: 'not-an-address' }] },
  { data: [] },
  {},
  'nope',
  null
];
const FOLDERS: unknown[] = [
  {
    data: [
      { folderId: '11', folderName: 'Inbox', folderType: 'Inbox' },
      { folderId: '12', folderName: 'Sent', folderType: 'Sent' }
    ]
  },
  {
    data: [
      { folderId: 21, folderName: 'Sent' },
      { folderId: 22, folderName: 'Posteingang', folderType: 'Inbox' }
    ]
  },
  { data: [] },
  'nope'
];
const HEADERS: unknown[] = [
  { data: 'Subject: Long\r\n subject line\r\nFrom: Ada <ada@northwind.test>' },
  { data: { headerContent: 'Message-ID: <a1@mx.test>\nIn-Reply-To: <b2@mx.test>' } },
  { data: { From: ['Ada <ada@northwind.test>'], Subject: 'Hello' } },
  {}
];

const ALTERNATIVE = [
  'From: Ada Lovelace <ada@northwind.test>',
  'Subject: Re: Quick question',
  'Message-ID: <reply-1@mx.northwind.test>',
  'In-Reply-To: <zoho-1777@mx.zoho.test>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="b1"',
  '',
  'This is a multi-part message in MIME format.',
  '--b1',
  'Content-Type: text/plain; charset=UTF-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Friday at the caf=C3=A9 works for a long=',
  ' chat.',
  '--b1',
  'Content-Type: text/html; charset=UTF-8',
  '',
  '<p>HTML must lose to plain text.</p>',
  '--b1--',
  ''
].join('\r\n');

const MIXED = [
  'From: ana@globex.test',
  'Subject: Re: Olá',
  'Content-Type: multipart/mixed; boundary=outer',
  '',
  '--outer',
  'Content-Type: text/plain; name="notes.txt"',
  'Content-Disposition: attachment; filename="notes.txt"',
  '',
  'attachment text that must not be read',
  '--outer',
  'Content-Type: multipart/alternative; boundary="inner"',
  '',
  '--inner',
  'Content-Type: text/html; charset=ISO-8859-1',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('<p>Olá, sexta serve.</p>', 'latin1').toString('base64'),
  '--inner--',
  '--outer--'
].join('\n');

function nestedMultipart(levels: number): string {
  let entity = 'Content-Type: text/plain\n\ndeep text';
  for (let level = 0; level < levels; level += 1) {
    entity = `Content-Type: multipart/mixed; boundary="l${level}"\n\n--l${level}\n${entity}\n--l${level}--`;
  }
  return `From: deep@northwind.test\n${entity}`;
}

describe('Zoho Mail sync helpers', () => {
  it('keeps the sync copies identical to the server parsers', () => {
    for (const body of ACCOUNTS) expect(syncPickZohoAccount(body)).toEqual(pickZohoAccount(body));
    for (const body of FOLDERS) {
      for (const kind of ['inbox', 'sent'] as const) {
        expect(syncPickZohoFolderId(body, kind)).toEqual(pickZohoFolderId(body, kind));
      }
    }
    for (const body of HEADERS) expect(syncParseZohoHeaders(body)).toEqual(parseZohoHeaders(body));
  });

  it('bounds one run so it fits inside the Zoho API limits', () => {
    expect(ZOHO_LIST_PAGE_SIZE).toBeLessThanOrEqual(200);
    expect(ZOHO_LIST_CEILING % ZOHO_LIST_PAGE_SIZE).toBe(0);
    expect(ZOHO_MAX_MESSAGES_PER_RUN).toBeLessThanOrEqual(ZOHO_LIST_CEILING);
  });

  it('reads list entries and drops ones without an id or a received time', () => {
    expect(
      zohoListEntries({
        data: [
          {
            messageId: '1777',
            receivedTime: '1791363600000',
            fromAddress: 'ada@northwind.test',
            subject: 'Re: Hi',
            summary: ' Friday works. '
          },
          { messageId: 1778, receivedTime: 1791363700000 },
          { messageId: '', receivedTime: '1791363800000' },
          { messageId: '1779', receivedTime: 'soon' },
          { messageId: '1780', receivedTime: '' },
          'nope'
        ]
      })
    ).toEqual([
      {
        messageId: '1777',
        receivedMs: 1791363600000,
        fromAddress: 'ada@northwind.test',
        subject: 'Re: Hi',
        summary: 'Friday works.'
      },
      {
        messageId: '1778',
        receivedMs: 1791363700000,
        fromAddress: null,
        subject: null,
        summary: ''
      }
    ]);
    expect(zohoListEntries({})).toEqual([]);
  });

  it('finds the raw MIME in every original-message shape', () => {
    expect(mimeFromOriginalMessage('From: a@b.test\n\nHi')).toBe('From: a@b.test\n\nHi');
    expect(mimeFromOriginalMessage({ data: 'From: a@b.test\n\nHi' })).toBe('From: a@b.test\n\nHi');
    expect(mimeFromOriginalMessage({ data: { content: 'From: a@b.test\n\nHi' } })).toBe(
      'From: a@b.test\n\nHi'
    );
    expect(mimeFromOriginalMessage({ data: { content: '   ' } })).toBeNull();
    expect(mimeFromOriginalMessage({})).toBeNull();
    expect(mimeFromOriginalMessage(null)).toBeNull();
  });

  it('prefers decoded plain text and keeps the reply headers', () => {
    const parsed = parseMimeMessage(ALTERNATIVE);
    expect(parsed.text).toBe('Friday at the café works for a long chat.');
    expect(headerValue(parsed.headers, 'Message-ID')).toBe('<reply-1@mx.northwind.test>');
    expect(headerValue(parsed.headers, 'In-Reply-To')).toBe('<zoho-1777@mx.zoho.test>');
  });

  it('skips attachments and falls back to latin1 base64 HTML', () => {
    const parsed = parseMimeMessage(MIXED);
    expect(parsed.text).toBe('Olá, sexta serve.');
    expect(parsed.text).not.toContain('attachment text');
    expect(headerValue(parsed.headers, 'From')).toBe('ana@globex.test');
  });

  it('reads a single-part message and stops at a bounded nesting depth', () => {
    expect(parseMimeMessage('From: x@northwind.test\r\n\r\nHello there.\r\n').text).toBe(
      'Hello there.'
    );
    expect(parseMimeMessage(nestedMultipart(3)).text).toBe('deep text');
    expect(parseMimeMessage(nestedMultipart(7)).text).toBe('');
    expect(parseMimeMessage('Content-Type: multipart/mixed\n\n--x\n\nno boundary').text).toBe('');
  });
});
