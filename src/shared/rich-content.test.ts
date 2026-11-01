import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LINKEDIN_POST_IMAGE_MAX_BYTES,
  LINKEDIN_POST_IMAGE_MAX_COUNT,
  LINKEDIN_POST_IMAGE_TYPES
} from '../server/linkedin/posts.js';
import {
  RICH_CONTENT_CHANNELS,
  RICH_CONTENT_MATRIX,
  RICH_CONTENT_TYPES,
  actionAttachmentViolation,
  checkRichContent,
  classifyAttachment,
  payloadAttachmentViolation,
  richContentChannelForActionKind,
  richContentChannelForStepAction,
  richContentMarkdown,
  variantRichContentViolation,
  workflowRichContentViolation,
  type RichAttachmentInput,
  type RichContentChannel,
  type RichContentType
} from './rich-content.js';

/** One well-formed attachment of each content type, sized well inside every limit. */
const SAMPLE: Record<RichContentType, RichAttachmentInput> = {
  image: {
    url: 'https://cdn.example.test/photo.png',
    name: 'photo.png',
    mimeType: 'image/png',
    sizeBytes: 2048
  },
  gif: {
    url: 'https://cdn.example.test/demo.gif',
    name: 'demo.gif',
    mimeType: 'image/gif',
    sizeBytes: 2048,
    mediaKind: 'gif'
  },
  video: {
    url: 'https://cdn.example.test/demo.mp4',
    name: 'demo.mp4',
    mimeType: 'video/mp4',
    sizeBytes: 2048
  },
  voice: {
    url: 'https://cdn.example.test/note.m4a',
    name: 'note.m4a',
    mimeType: 'audio/mp4',
    sizeBytes: 2048,
    mediaKind: 'voice'
  },
  document: {
    url: 'https://cdn.example.test/deck.pdf',
    name: 'deck.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 2048
  }
};

const cells = RICH_CONTENT_CHANNELS.flatMap((channel) =>
  RICH_CONTENT_TYPES.map((type) => ({
    channel,
    type,
    cell: RICH_CONTENT_MATRIX[channel].cells[type]
  }))
);

describe('the rich-content matrix', () => {
  it('has a non-empty reason for every cell, and limits that agree with the cells', () => {
    for (const { channel, type, cell } of cells) {
      expect(cell.reason.length, `${channel}/${type}`).toBeGreaterThan(20);
    }
    for (const channel of RICH_CONTENT_CHANNELS) {
      const spec = RICH_CONTENT_MATRIX[channel];
      const anySupported = RICH_CONTENT_TYPES.some(
        (type) => spec.cells[type].support === 'supported'
      );
      expect(spec.maxCount > 0, channel).toBe(anySupported);
      expect(spec.maxBytes > 0, channel).toBe(anySupported);
      expect(spec.allowedMimeTypes.length > 0, channel).toBe(anySupported);
    }
  });

  it('marks voice unsupported on every channel and video unsupported on DMs, InMail and posts', () => {
    for (const channel of RICH_CONTENT_CHANNELS)
      expect(RICH_CONTENT_MATRIX[channel].cells.voice.support, channel).toBe('unsupported');
    for (const channel of ['linkedin_message', 'linkedin_inmail', 'linkedin_post'] as const)
      expect(RICH_CONTENT_MATRIX[channel].cells.video.support, channel).toBe('unsupported');
    expect(RICH_CONTENT_MATRIX.linkedin_message.cells.voice.reason).toMatch(/mobile app/);
  });

  it.each(cells.map((entry) => [entry.channel, entry.type, entry.cell.support] as const))(
    '%s / %s (%s): one accepted and one refused case',
    (channel, type, support) => {
      const spec = RICH_CONTENT_MATRIX[channel];
      if (support === 'supported') {
        expect(checkRichContent(channel, [SAMPLE[type]])).toBeNull();
        expect(
          checkRichContent(channel, [{ ...SAMPLE[type], sizeBytes: spec.maxBytes + 1 }])
        ).toMatchObject({ code: 'attachment_too_large', channel, contentType: type, index: 0 });
      } else {
        // The accepted alternative the cell names: a link in the text, no attachment.
        expect(checkRichContent(channel, [])).toBeNull();
        const refusal = checkRichContent(channel, [SAMPLE[type]]);
        expect(refusal).toMatchObject({
          code: 'content_type_unsupported',
          channel,
          contentType: type,
          index: 0
        });
        expect(refusal!.reason).toContain(spec.cells[type].reason);
        expect(refusal!.reason).toContain(support === 'link_only' ? 'link-only' : 'not supported');
      }
    }
  );

  it.each(RICH_CONTENT_CHANNELS.filter((channel) => RICH_CONTENT_MATRIX[channel].maxCount > 0))(
    '%s: size and count exactly at the limit pass, one past refuses',
    (channel) => {
      const spec = RICH_CONTENT_MATRIX[channel];
      const image = { ...SAMPLE.image, mimeType: 'image/png' };
      expect(checkRichContent(channel, [{ ...image, sizeBytes: spec.maxBytes }])).toBeNull();
      expect(checkRichContent(channel, [{ ...image, sizeBytes: spec.maxBytes + 1 }])).toMatchObject(
        {
          code: 'attachment_too_large'
        }
      );
      const atLimit = Array.from({ length: spec.maxCount }, () => image);
      expect(checkRichContent(channel, atLimit)).toBeNull();
      expect(checkRichContent(channel, [...atLimit, image])).toMatchObject({
        code: 'too_many_attachments',
        contentType: null,
        index: null
      });
    }
  );

  it('answers a text-only channel with the cell reason, never "too many"', () => {
    expect(checkRichContent('linkedin_reply', [SAMPLE.document])).toMatchObject({
      code: 'content_type_unsupported'
    });
  });

  it('refuses a supported type whose MIME is outside the row', () => {
    expect(
      checkRichContent('linkedin_message', [{ url: 'https://cdn.example.test/deck.docx' }])
    ).toMatchObject({ code: 'content_type_unsupported', contentType: 'document' });
    expect(
      checkRichContent('linkedin_message', [{ url: 'https://cdn.example.test/photo.heic' }])
    ).toMatchObject({ code: 'content_type_unsupported', contentType: 'image' });
    expect(
      checkRichContent('linkedin_post', [{ mimeType: 'image/webp', sizeBytes: 10 }])
    ).toBeNull();
    expect(
      checkRichContent('linkedin_message', [{ mimeType: 'image/webp', sizeBytes: 10 }])
    ).toMatchObject({ code: 'content_type_unsupported' });
  });
});

describe('classification', () => {
  it('reads declared MIME, then file name, then URL, and lets a voice declaration win', () => {
    expect(classifyAttachment({ mimeType: 'IMAGE/PNG; charset=binary' })).toEqual({
      type: 'image',
      mimeType: 'image/png'
    });
    expect(classifyAttachment({ mimeType: 'application/octet-stream', name: 'clip.mov' })).toEqual({
      type: 'video',
      mimeType: 'video/quicktime'
    });
    expect(classifyAttachment({ url: 'https://cdn.example.test/deck.pdf?sig=1' })).toEqual({
      type: 'document',
      mimeType: 'application/pdf'
    });
    expect(classifyAttachment({ url: 'https://cdn.example.test/file', mediaKind: 'gif' })).toEqual({
      type: 'gif',
      mimeType: null
    });
    expect(classifyAttachment({ url: 'https://cdn.example.test/file' })).toEqual({
      type: 'document',
      mimeType: null
    });
    expect(
      classifyAttachment({ url: 'https://cdn.example.test/a.png', mediaKind: 'voice' }).type
    ).toBe('voice');
  });
});

describe('mapping product shapes onto the matrix', () => {
  it('maps every message-bearing step and action kind to a row', () => {
    expect(
      ['connection_request', 'message', 'inmail', 'email', 'group_message', 'event_message'].map(
        richContentChannelForStepAction
      )
    ).toEqual([
      'linkedin_invite_note',
      'linkedin_message',
      'linkedin_inmail',
      'email',
      'linkedin_group_message',
      'linkedin_event_message'
    ]);
    expect(richContentChannelForStepAction('profile_view')).toBeNull();
    expect(
      ['dm', 'inmail', 'invite', 'reply', 'group_message', 'event_message'].map(
        richContentChannelForActionKind
      )
    ).toEqual([
      'linkedin_message',
      'linkedin_inmail',
      'linkedin_invite_note',
      'linkedin_reply',
      'linkedin_group_message',
      'linkedin_event_message'
    ]);
  });

  it('names the step and variant that break the matrix, and counts a URL-less voice note', () => {
    expect(
      workflowRichContentViolation([
        { id: 'view', action: 'profile_view', config: {} },
        {
          id: 'dm',
          action: 'message',
          config: {
            variants: [
              { id: 'a', attachmentUrl: 'https://cdn.example.test/deck.pdf', mediaKind: 'file' },
              { id: 'b', mediaKind: 'voice' }
            ]
          }
        }
      ])
    ).toMatchObject({ stepId: 'dm', variantId: 'b', contentType: 'voice' });
    expect(
      variantRichContentViolation('connection_request', {
        attachmentUrl: 'https://cdn.example.test/deck.pdf'
      })
    ).toMatchObject({ code: 'content_type_unsupported', channel: 'linkedin_invite_note' });
    expect(variantRichContentViolation('message', { mediaKind: 'file' })).toBeNull();
  });

  it('reads a stored attachment column in every shape it can take', () => {
    const pdf = { url: 'https://cdn.example.test/deck.pdf', name: 'deck.pdf', mediaKind: 'file' };
    expect(actionAttachmentViolation('dm', pdf)).toBeNull();
    expect(actionAttachmentViolation('dm', JSON.stringify(pdf))).toBeNull();
    expect(actionAttachmentViolation('dm', null)).toBeNull();
    expect(actionAttachmentViolation('dm', {})).toBeNull();
    expect(actionAttachmentViolation('dm', [pdf, pdf])).toMatchObject({
      code: 'too_many_attachments'
    });
    expect(actionAttachmentViolation('dm', '{not json')).toMatchObject({
      code: 'content_type_unsupported',
      reason: expect.stringContaining('cannot be read')
    });
    expect(actionAttachmentViolation('invite', pdf)).toMatchObject({
      channel: 'linkedin_invite_note'
    });
    expect(actionAttachmentViolation('dm', { ...pdf, mediaKind: 'voice' })).toMatchObject({
      contentType: 'voice'
    });
    expect(actionAttachmentViolation('profile_view', pdf)).toMatchObject({ channel: null });
  });

  it('refuses an external-write payload that names attachments under any usual key', () => {
    const base = { recipient: 'maya@example.test', subject: 'Hi', body: 'Hello' };
    expect(payloadAttachmentViolation('email', base)).toBeNull();
    for (const key of ['attachments', 'attachment', 'media', 'images', 'files'])
      expect(
        payloadAttachmentViolation('email', { ...base, [key]: [SAMPLE.document] }),
        key
      ).toMatchObject({ code: 'content_type_unsupported', channel: 'email' });
    expect(payloadAttachmentViolation('buffer_draft', { media: [SAMPLE.image] })).toMatchObject({
      channel: 'buffer_draft'
    });
  });
});

describe('surfaces generated from the matrix', () => {
  it('keeps docs/rich-content.md in sync with the module', () => {
    const doc = readFileSync(new URL('../../docs/rich-content.md', import.meta.url), 'utf8');
    const begin = doc.indexOf('-->', doc.indexOf('<!-- rich-content-matrix:begin')) + 3;
    const end = doc.indexOf('<!-- rich-content-matrix:end -->');
    expect(begin).toBeGreaterThan(3);
    expect(doc.slice(begin, end).trim()).toBe(richContentMarkdown());
  });

  it('derives the post upload limits from the linkedin_post row', () => {
    const row = RICH_CONTENT_MATRIX.linkedin_post;
    expect([...LINKEDIN_POST_IMAGE_TYPES].sort()).toEqual([...row.allowedMimeTypes].sort());
    expect(LINKEDIN_POST_IMAGE_MAX_COUNT).toBe(row.maxCount);
    expect(LINKEDIN_POST_IMAGE_MAX_BYTES).toBe(row.maxBytes);
  });

  it('covers each channel once', () => {
    const channels: RichContentChannel[] = [...RICH_CONTENT_CHANNELS];
    expect(new Set(channels).size).toBe(channels.length);
    expect(Object.keys(RICH_CONTENT_MATRIX).sort()).toEqual([...channels].sort());
  });
});
