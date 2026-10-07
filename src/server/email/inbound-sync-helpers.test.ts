import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  INBOUND_ADDRESS_METADATA_KEY as SYNC_METADATA_KEY,
  INBOUND_EMAIL_MESSAGE_MODEL as SYNC_MODEL_NAME,
  INBOUND_SYNC_NAME as SYNC_NAME,
  MAX_BODY_CHARS,
  MAX_REPLY_TO_IDS,
  UNSUBSCRIBE_SUBJECT_PATTERN as SYNC_UNSUBSCRIBE_PATTERN,
  buildInboundRecord,
  decodeMimeWords,
  decodePartData,
  headerValue,
  htmlToText,
  isBulkMail,
  normalizeAddress,
  parseAddress,
  replyToMessageIds
} from '../../../nango-integrations/shared/inbound-email.js';
import { INBOUND_ADDRESS_METADATA_KEY } from './channel.js';
import { INBOUND_EMAIL_MESSAGE_MODEL, INBOUND_SYNC_NAME } from './inbound-mailbox.js';
import { UNSUBSCRIBE_SUBJECT_PATTERN } from './unsubscribe.js';
import { canonicalRecordSchema } from '../integration-service.js';

const header = (name: string, value: string) => ({ name, value });
const TOKEN = `del_0123456789abcdef.${'A'.repeat(43)}`;

const base = {
  id: 'msg-1',
  mailboxAddress: 'Founder@Acme.test',
  from: 'Ada Lovelace <Ada@Client.test>',
  subject: 'Re: proposal',
  body: 'x'.repeat(MAX_BODY_CHARS + 10),
  occurredAt: 1791277500000,
  externalUrl: 'https://mail.google.com/mail/?authuser=founder%40acme.test#all/msg-1',
  internetMessageId: '<reply-1@client.test>',
  headers: [
    header('In-Reply-To', '<del-1@trevra.app>'),
    header('References', '<a@x.test> <del-1@trevra.app> <b@x.test>'),
    header('Auto-Submitted', 'no')
  ]
};

describe('inbound-messages sync helpers', () => {
  it('mirror the server unsubscribe pattern and email check exactly', () => {
    expect(SYNC_UNSUBSCRIBE_PATTERN.source).toBe(UNSUBSCRIBE_SUBJECT_PATTERN.source);
    expect(SYNC_UNSUBSCRIBE_PATTERN.flags).toBe(UNSUBSCRIBE_SUBJECT_PATTERN.flags);
    for (const sample of [
      'ada@example.test',
      'a.b+c@sub.example.co',
      "o'neil@example.test",
      '.ada@example.test',
      'ada..b@example.test',
      'ada@localhost',
      'ada@exa_mple.test',
      'not an address'
    ]) {
      expect(normalizeAddress(sample) !== null).toBe(z.string().email().safeParse(sample).success);
    }
  });

  it('uses the same sync name, model name and metadata key as Trevra', () => {
    expect(SYNC_NAME).toBe(INBOUND_SYNC_NAME);
    expect(SYNC_MODEL_NAME).toBe(INBOUND_EMAIL_MESSAGE_MODEL);
    expect(SYNC_METADATA_KEY).toBe(INBOUND_ADDRESS_METADATA_KEY);
  });

  it('has a sync file per integration that uses the shared constants and model', () => {
    const root = new URL('../../../nango-integrations/', import.meta.url);
    for (const integration of ['trevra-gmail', 'trevra-microsoft']) {
      const source = readFileSync(
        new URL(`${integration}/syncs/${INBOUND_SYNC_NAME}.ts`, root),
        'utf8'
      );
      expect(source).toContain('models: { InboundEmailMessage }');
      expect(source).toContain('INBOUND_EMAIL_MESSAGE_MODEL');
      expect(source).toContain('metadata?.[INBOUND_ADDRESS_METADATA_KEY]');
    }
    const model = readFileSync(new URL('shared/inbound-model.ts', root), 'utf8');
    expect(model).toContain(`export const ${INBOUND_EMAIL_MESSAGE_MODEL} =`);
    expect(model).toContain('[INBOUND_ADDRESS_METADATA_KEY]');
  });

  it('reads headers case-insensitively and unfolds multi-line References', () => {
    expect(headerValue([header('MESSAGE-id', '<a@x.test>')], 'Message-ID')).toBe('<a@x.test>');
    expect(headerValue([], 'Message-ID')).toBeNull();
    const record = buildInboundRecord({
      ...base,
      headers: [header('references', '<a@x.test>\r\n\t<b@x.test>\r\n <c@x.test>')]
    });
    expect(record!.replyToMessageIds).toEqual(['<c@x.test>', '<b@x.test>', '<a@x.test>']);
  });

  it('converts html to text without double-decoding entities', () => {
    expect(htmlToText('<p>a &amp;lt; b</p><style>x{}</style><br>c &amp; d')).toBe(
      'a &lt; b\n\nc & d'
    );
    expect(htmlToText('1 &lt; 2 &nbsp;&quot;ok&quot;')).toBe('1 < 2  "ok"');
  });

  it('passes Auto-Submitted values through', () => {
    const record = buildInboundRecord({
      ...base,
      headers: [header('Auto-Submitted', ' auto-replied ')]
    });
    expect(record!.autoSubmitted).toBe('auto-replied');
  });

  it('decodes Gmail part data by the declared charset', () => {
    const data = Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString('base64url');
    const type = (value: string) => [header('Content-Type', value)];
    expect(decodePartData(data, type('text/plain; charset="ISO-8859-1"'))).toBe('café');
    expect(decodePartData(data, type('text/plain; charset=windows-1252'))).toBe('café');
    expect(decodePartData(data, type('text/plain; charset=UTF-8'))).toBe('caf�');
    expect(decodePartData(data)).toBe('caf�');
    const utf8 = Buffer.from('café', 'utf8').toString('base64url');
    expect(decodePartData(utf8, type('text/plain'))).toBe('café');
  });

  it('decodes RFC 2047 names and subjects', () => {
    expect(decodeMimeWords('=?UTF-8?B?SMOpbMOobmU=?=')).toBe('Hélène');
    expect(decodeMimeWords('=?ISO-8859-1?Q?Caf=E9_cr=E8me?=')).toBe('Café crème');
    expect(decodeMimeWords('=?UTF-8?Q?a?= =?UTF-8?Q?b?= c')).toBe('ab c');
    expect(decodeMimeWords('=?KOI8-R?B?AAAA?=')).toBe('=?KOI8-R?B?AAAA?=');
    expect(parseAddress('"=?UTF-8?B?SMOpbMOobmU=?=" <Helene@Example.TEST>')).toEqual({
      address: 'helene@example.test',
      name: 'Hélène'
    });
    expect(parseAddress('bob@example.test')).toEqual({ address: 'bob@example.test', name: null });
    expect(parseAddress('undisclosed-recipients:;').address).toBeNull();
  });

  it('skips list mail unless it carries a Trevra unsubscribe token', () => {
    expect(isBulkMail([header('List-Unsubscribe', '<mailto:x@y.test>')], 'Weekly digest')).toBe(
      true
    );
    expect(isBulkMail([header('Precedence', 'Bulk')], 'Hi')).toBe(true);
    expect(isBulkMail([header('List-Id', '<x.y.test>')], `unsubscribe ${TOKEN}`)).toBe(false);
    expect(isBulkMail([header('Precedence', 'first-class')], 'Re: proposal')).toBe(false);
  });

  it('builds a canonical inbound message record', () => {
    const record = buildInboundRecord(base);
    expect(record).toMatchObject({
      id: 'msg-1',
      kind: 'message',
      direction: 'inbound',
      mailboxAddress: 'founder@acme.test',
      personEmail: 'ada@client.test',
      personName: 'Ada Lovelace',
      subject: 'Re: proposal',
      occurredAt: '2026-10-06T09:05:00.000Z',
      externalUrl: base.externalUrl,
      internetMessageId: '<reply-1@client.test>',
      replyToMessageIds: ['<del-1@trevra.app>', '<b@x.test>', '<a@x.test>'],
      autoSubmitted: 'no'
    });
    expect(record!.body).toHaveLength(MAX_BODY_CHARS);
    expect(z.string().datetime().safeParse(record!.occurredAt).success).toBe(true);
    expect(z.string().url().safeParse(record!.externalUrl).success).toBe(true);
  });

  it('builds a record that Trevra canonicalRecordSchema accepts', () => {
    const parsed = canonicalRecordSchema.safeParse(buildInboundRecord(base));
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.kind === 'message') {
      expect(parsed.data.mailboxAddress).toBe('founder@acme.test');
      expect(parsed.data.replyToMessageIds).toHaveLength(3);
      expect(parsed.data.autoSubmitted).toBe('no');
    }
  });

  it('drops self-sent, senderless, list and undated mail', () => {
    expect(buildInboundRecord({ ...base, from: 'Founder <founder@acme.test>' })).toBeNull();
    expect(buildInboundRecord({ ...base, from: null })).toBeNull();
    expect(buildInboundRecord({ ...base, from: 'not an address' })).toBeNull();
    expect(
      buildInboundRecord({ ...base, headers: [header('List-Id', '<news.client.test>')] })
    ).toBeNull();
    expect(buildInboundRecord({ ...base, occurredAt: 'yesterday-ish' })).toBeNull();
    expect(buildInboundRecord({ ...base, occurredAt: null })).toBeNull();
  });

  it('caps the reply-to ids it forwards', () => {
    const references = Array.from({ length: 80 }, (_, index) => `<r${index}@x.test>`).join(' ');
    const ids = replyToMessageIds('<first@x.test>', references);
    expect(ids).toHaveLength(MAX_REPLY_TO_IDS);
    expect(ids[0]).toBe('<first@x.test>');
    expect(ids[1]).toBe('<r79@x.test>');
  });
});
