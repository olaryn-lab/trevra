import { describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { EXECUTION_ACTION_TYPES, executePreparedPlaybookAction } from './execution.js';

describe('GTM prepared-action boundary', () => {
  it('exposes the named GTM execution actions', () => {
    expect(EXECUTION_ACTION_TYPES).toEqual([
      'email.send',
      'community.reply',
      'crm.log-activity',
      'buffer.create-draft',
      'crm.upsert-contact'
    ]);
  });
  it('validates the GTM email payload before touching a connection', async () => {
    await expect(
      executePreparedPlaybookAction({} as Db, {
        workspaceId: 'ws_test',
        actionType: 'email.send',
        payload: { recipient: 'not-an-email', subject: '', body: '' },
        payloadHash: 'c'.repeat(64)
      })
    ).rejects.toThrow();
  });

  it('TRV-040: refuses attachments on text-only channels before any connection, never strips them', async () => {
    const cases = [
      {
        actionType: 'email.send' as const,
        payload: {
          recipient: 'maya@example.test',
          subject: 'Deck',
          body: 'Attached.',
          attachments: [{ url: 'https://cdn.example.test/deck.pdf', mimeType: 'application/pdf' }]
        },
        contentType: 'document',
        message: /link-only on Email/
      },
      {
        actionType: 'community.reply' as const,
        payload: { body: 'See clip', media: 'https://cdn.example.test/clip.mp4' },
        contentType: 'video',
        message: /link-only on Community reply/
      },
      {
        actionType: 'buffer.create-draft' as const,
        payload: { text: 'Launch', images: [{ url: 'https://cdn.example.test/shot.png' }] },
        contentType: 'image',
        message: /not supported on Buffer draft/
      }
    ];
    for (const { actionType, payload, contentType, message } of cases) {
      const refusal = await executePreparedPlaybookAction({} as Db, {
        workspaceId: 'ws_test',
        actionType,
        payload,
        payloadHash: 'c'.repeat(64)
      }).then(
        () => null,
        (error: unknown) => error as Error & { code?: string; retryable?: boolean }
      );
      expect(refusal, actionType).not.toBeNull();
      expect(refusal, actionType).toMatchObject({
        code: 'content_type_unsupported',
        retryable: false
      });
      expect(refusal!.message, actionType).toMatch(message);
      expect(refusal!.message, actionType).toContain('Nothing was sent.');
      expect(refusal!.message.toLowerCase(), actionType).toContain(contentType);
    }
  });
});
