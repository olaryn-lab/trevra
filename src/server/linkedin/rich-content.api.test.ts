import { createHash, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { id, openDatabase, type Db } from '../db.js';
import { importLeadCsv } from './lead-lists.js';
import { upsertSeat } from './seats.js';
import { enqueueReply, syncThreads } from './inbox.js';
import { createPost } from './posts.js';
import { LinkedInApiError } from './errors.js';
import {
  RICH_CONTENT_MATRIX,
  RICH_CONTENT_TYPES,
  richContentChannelForStepAction,
  type RichContentChannel,
  type RichContentType
} from '../../shared/rich-content.js';

/**
 * TRV-040: every write path that accepts rich content, against every cell of
 * the matrix it serves -- one accepted and one refused case per cell, through
 * the real HTTP surface and a real PostgreSQL.
 */

let db: Db;
let app: Express;
const A = 'ws_rich_content_api_a';
const B = 'ws_rich_content_api_b';
const NOW = new Date('2026-08-04T10:00:00.000Z');
const MB = 1024 * 1024;
let tokenA = '';
let tokenB = '';

async function session(workspaceId: string): Promise<string> {
  const userId = `usr_${workspaceId}`;
  await db
    .prepare(
      'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(workspaceId, workspaceId, NOW.toISOString());
  await db
    .prepare(
      'INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(userId, workspaceId, `${userId}@trevra.test`, workspaceId, NOW.toISOString());
  const token = randomBytes(32).toString('hex');
  await db
    .prepare('INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)')
    .run(
      createHash('sha256').update(token).digest('hex'),
      userId,
      new Date(Date.now() + 86_400_000).toISOString(),
      NOW.toISOString()
    );
  return token;
}

function as(token: string) {
  const cookie = `trevra_session=${token}`;
  return {
    get: (path: string) => request(app).get(path).set('Cookie', cookie),
    post: (path: string) => request(app).post(path).set('Cookie', cookie),
    put: (path: string) => request(app).put(path).set('Cookie', cookie)
  };
}

async function clear(workspaceId: string) {
  for (const table of [
    'linkedin_manual_tasks',
    'linkedin_actions',
    'linkedin_messages',
    'linkedin_threads',
    'linkedin_campaign_members',
    'linkedin_campaigns',
    'linkedin_workflows',
    'linkedin_lead_contacts',
    'linkedin_lead_lists',
    'linkedin_posts',
    'linkedin_seats'
  ])
    await db.prepare(`DELETE FROM ${table} WHERE workspace_id=?`).run(workspaceId);
}

beforeAll(async () => migrateAuthDatabase());
afterAll(async () => closeAuthDatabase());
beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
  await clear(A);
  await clear(B);
  tokenA = await session(A);
  tokenB = await session(B);
  for (const workspaceId of [A, B])
    await upsertSeat(
      db,
      workspaceId,
      { label: 'Owner', timezone: 'UTC' },
      new Date(NOW.getTime() - 60 * 86_400_000)
    );
});
afterEach(async () => {
  await db?.close();
});

/* ---------------------------------------------------------------------------
 * Fixtures.
 * ------------------------------------------------------------------------ */

const FILE_URL: Record<RichContentType, string> = {
  image: 'https://cdn.example.test/photo.png',
  gif: 'https://cdn.example.test/demo.gif',
  video: 'https://cdn.example.test/demo.mp4',
  voice: 'https://cdn.example.test/note.m4a',
  document: 'https://cdn.example.test/deck.pdf'
};

/** A workflow variant asking for one attachment of this type. */
const VARIANT_MEDIA: Record<RichContentType, Record<string, string>> = {
  image: { attachmentUrl: FILE_URL.image, mediaKind: 'file' },
  gif: { attachmentUrl: FILE_URL.gif, mediaKind: 'gif' },
  video: { attachmentUrl: FILE_URL.video, mediaKind: 'file' },
  voice: { attachmentUrl: FILE_URL.voice, mediaKind: 'voice' },
  document: { attachmentUrl: FILE_URL.document, mediaKind: 'file' }
};

/**
 * The same type in a file the row refuses. A workflow variant declares no
 * size, so for a supported cell the refused case at this path is a MIME type
 * outside the row; GIF has exactly one MIME, so its refused case is proven at
 * the paths that carry a size (queued edit, post upload, driver).
 */
const VARIANT_WRONG_FILE: Partial<Record<RichContentType, Record<string, string>>> = {
  image: { attachmentUrl: 'https://cdn.example.test/photo.heic', mediaKind: 'file' },
  document: { attachmentUrl: 'https://cdn.example.test/deck.docx', mediaKind: 'file' }
};

/** A message-request attachment of this type, as the queue routes accept it. */
const REQUEST_MEDIA: Record<RichContentType, Record<string, unknown>> = {
  image: { url: FILE_URL.image, name: 'photo.png', mimeType: 'image/png', sizeBytes: 2048 },
  gif: {
    url: FILE_URL.gif,
    name: 'demo.gif',
    mimeType: 'image/gif',
    sizeBytes: 2048,
    mediaKind: 'gif'
  },
  video: { url: FILE_URL.video, name: 'demo.mp4', mimeType: 'video/mp4', sizeBytes: 2048 },
  voice: {
    url: FILE_URL.voice,
    name: 'note.m4a',
    mimeType: 'audio/mp4',
    sizeBytes: 2048,
    mediaKind: 'voice'
  },
  document: {
    url: FILE_URL.document,
    name: 'deck.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 2048
  }
};

const STEP_ACTIONS = [
  'connection_request',
  'message',
  'inmail',
  'email',
  'group_message',
  'event_message'
] as const;
type StepAction = (typeof STEP_ACTIONS)[number];

function stepFor(action: StepAction, variant: Record<string, unknown>) {
  const v = { id: 'a', body: 'Hi {{first_name}}', weight: 100, ...variant };
  const base = { id: 's1', action, delayBefore: { amount: 0, unit: 'hours' } };
  switch (action) {
    case 'connection_request':
    case 'message':
      return { ...base, config: { variants: [v] } };
    case 'inmail':
      return { ...base, config: { subject: 'Hello', variants: [v] } };
    case 'email':
      return {
        ...base,
        config: { subject: 'Hello', variants: [v], tracking: 'off', threaded: false }
      };
    case 'group_message':
      return {
        ...base,
        config: { groupUrl: 'https://www.linkedin.com/groups/123/', variants: [v] }
      };
    case 'event_message':
      return {
        ...base,
        config: { eventUrl: 'https://www.linkedin.com/events/123/', variants: [v] }
      };
  }
}

const stepCells = STEP_ACTIONS.flatMap((action) =>
  RICH_CONTENT_TYPES.map((type) => {
    const channel = richContentChannelForStepAction(action)!;
    return { action, type, channel, cell: RICH_CONTENT_MATRIX[channel].cells[type] };
  })
);

function expectRefusal(
  body: Record<string, unknown>,
  code: string,
  channel: RichContentChannel,
  type: RichContentType | null
) {
  expect(body).toMatchObject({ code, channel, contentType: type });
  expect(typeof body.reason).toBe('string');
  expect(body.error).toEqual(expect.stringContaining(String(body.reason).slice(0, 40)));
}

async function planned(
  workspaceId: string,
  kind: 'dm' | 'reply',
  attachment: unknown = null
): Promise<string> {
  const actionId = id('lact');
  await db
    .prepare(
      `INSERT INTO linkedin_actions
         (id,workspace_id,seat_key,kind,target_ref,status,planned_for,source,body,thread_urn,attachment_json,created_at)
       VALUES (?,?,'owner',?,?,'planned',?,'manual','Queued words',?,?::jsonb,?)`
    )
    .run(
      actionId,
      workspaceId,
      kind,
      `https://www.linkedin.com/in/${actionId}/`,
      NOW.toISOString(),
      kind === 'reply' ? `2-${actionId}==` : null,
      attachment === null ? null : JSON.stringify(attachment),
      NOW.toISOString()
    );
  return actionId;
}

/* ---------------------------------------------------------------------------
 * Workflow and campaign step saves (all six step channels, including email).
 * ------------------------------------------------------------------------ */

describe('TRV-040 workflow save, validate and campaign sequence', () => {
  it.each(stepCells.map((entry) => [entry.action, entry.type, entry.cell.support] as const))(
    'workflow save: %s / %s (%s)',
    async (action, type, support) => {
      const channel = richContentChannelForStepAction(action)!;
      const save = (variant: Record<string, unknown>, name: string) =>
        as(tokenA)
          .post('/api/linkedin/manager/workflows')
          .send({ name, steps: [stepFor(action, variant)] });
      if (support === 'supported') {
        await save(VARIANT_MEDIA[type], `accept ${action} ${type}`).expect(201);
        const wrong = VARIANT_WRONG_FILE[type];
        if (wrong) {
          const refused = await save(wrong, `refuse ${action} ${type}`).expect(422);
          expectRefusal(refused.body, 'content_type_unsupported', channel, type);
        }
        return;
      }
      // Accepted: what the cell says to do instead -- a link in the text.
      await save(
        { body: `Hi {{first_name}}, here it is: ${FILE_URL[type]}` },
        `accept link ${action} ${type}`
      ).expect(201);
      const refused = await save(VARIANT_MEDIA[type], `refuse ${action} ${type}`).expect(422);
      expectRefusal(refused.body, 'content_type_unsupported', channel, type);
      expect(refused.body).toMatchObject({ stepId: 's1', variantId: 'a' });
      expect(refused.body.reason).toContain(RICH_CONTENT_MATRIX[channel].cells[type].reason);

      const validated = await as(tokenA)
        .post('/api/linkedin/manager/workflows/validate')
        .send({ steps: [stepFor(action, VARIANT_MEDIA[type])] })
        .expect(200);
      expect(validated.body).toMatchObject({
        valid: false,
        issues: [{ code: 'content_type_unsupported', stepId: 's1', variantId: 'a' }]
      });
    }
  );

  it('applies the same matrix to a campaign sequence edit and to campaign creation from a legacy workflow', async () => {
    const list = (
      await as(tokenA)
        .post('/api/linkedin/manager/lead-lists')
        .send({ name: 'Rich content targets', sourceKind: 'csv' })
        .expect(201)
    ).body.list;
    await importLeadCsv(
      db,
      {
        workspaceId: A,
        listId: list.id,
        csv: 'First Name,Last Name,Company,Email,LinkedIn URL\nMaya,Rich,Acme,maya-rich@acme.test,https://linkedin.com/in/maya-rich-content\n'
      },
      NOW
    );
    const flow = (
      await as(tokenA)
        .post('/api/linkedin/manager/workflows')
        .send({
          name: 'Plain flow',
          steps: [
            {
              id: 'view',
              action: 'profile_view',
              delayBefore: { amount: 0, unit: 'hours' },
              config: {}
            }
          ]
        })
        .expect(201)
    ).body.workflow;
    const campaign = (
      await as(tokenA)
        .post('/api/linkedin/manager/campaigns')
        .send({ name: 'Rich content campaign', leadListId: list.id, workflowId: flow.id })
        .expect(201)
    ).body.campaign;

    for (const { action, type, channel, cell } of stepCells) {
      const put = (variant: Record<string, unknown>) =>
        as(tokenA)
          .put(`/api/linkedin/manager/campaigns/${campaign.id}/sequence`)
          .send({ steps: [stepFor(action, variant)] });
      const label = `${action}/${type}`;
      if (cell.support === 'supported') {
        expect((await put(VARIANT_MEDIA[type])).status, label).toBe(200);
        const wrong = VARIANT_WRONG_FILE[type];
        if (wrong) {
          const refused = await put(wrong);
          expect(refused.status, label).toBe(422);
          expectRefusal(refused.body, 'content_type_unsupported', channel, type);
        }
      } else {
        expect((await put({ body: `See ${FILE_URL[type]}` })).status, label).toBe(200);
        const refused = await put(VARIANT_MEDIA[type]);
        expect(refused.status, label).toBe(422);
        expectRefusal(refused.body, 'content_type_unsupported', channel, type);
      }
    }

    // A workflow saved before the matrix existed: written straight to the table.
    const legacyId = id('lwf');
    await db
      .prepare(
        `INSERT INTO linkedin_workflows (id,workspace_id,name,scope,owner_user_id,steps_json,version,created_at,updated_at)
         VALUES (?,?,?,'workspace',NULL,?::jsonb,1,?,?)`
      )
      .run(
        legacyId,
        A,
        'Legacy invite with a file',
        JSON.stringify([stepFor('connection_request', VARIANT_MEDIA.document)]),
        NOW.toISOString(),
        NOW.toISOString()
      );
    const refused = await as(tokenA)
      .post('/api/linkedin/manager/campaigns')
      .send({ name: 'Legacy campaign', leadListId: list.id, workflowId: legacyId })
      .expect(422);
    expectRefusal(refused.body, 'content_type_unsupported', 'linkedin_invite_note', 'document');
    const campaigns = await db
      .prepare(
        'SELECT COUNT(*)::int AS total FROM linkedin_campaigns WHERE workspace_id=? AND name=?'
      )
      .get<{ total: number }>(A, 'Legacy campaign');
    expect(campaigns?.total).toBe(0);
  });
});

/* ---------------------------------------------------------------------------
 * Manual queue: queued-message edits (dm and reply rows).
 * ------------------------------------------------------------------------ */

describe('TRV-040 queued-message edit', () => {
  it.each(
    RICH_CONTENT_TYPES.map(
      (type) => [type, RICH_CONTENT_MATRIX.linkedin_message.cells[type].support] as const
    )
  )('dm / %s (%s)', async (type, support) => {
    const actionId = await planned(A, 'dm');
    const edit = (payload: Record<string, unknown>) =>
      as(tokenA).post(`/api/linkedin/actions/${actionId}/body`).send(payload);
    if (support === 'supported') {
      const atLimit = { ...REQUEST_MEDIA[type], sizeBytes: 10 * MB };
      const accepted = await edit({ body: 'With the file', attachments: [atLimit] }).expect(200);
      expect(accepted.body.action.id).toBe(actionId);
      const stored = await db
        .prepare('SELECT attachment_json FROM linkedin_actions WHERE id=?')
        .get<{ attachment_json: Record<string, unknown> }>(actionId);
      expect(stored?.attachment_json).toMatchObject({ url: FILE_URL[type], sizeBytes: 10 * MB });
      const tooLarge = await edit({
        body: 'With the file',
        attachments: [{ ...atLimit, sizeBytes: 10 * MB + 1 }]
      }).expect(413);
      expectRefusal(tooLarge.body, 'attachment_too_large', 'linkedin_message', type);
    } else {
      await edit({ body: `Here: ${FILE_URL[type]}`, attachments: [] }).expect(200);
      const refused = await edit({
        body: 'With the file',
        attachments: [REQUEST_MEDIA[type]]
      }).expect(422);
      expectRefusal(refused.body, 'content_type_unsupported', 'linkedin_message', type);
    }
  });

  it.each(
    RICH_CONTENT_TYPES.map(
      (type) => [type, RICH_CONTENT_MATRIX.linkedin_reply.cells[type].support] as const
    )
  )('reply / %s (%s)', async (type) => {
    const actionId = await planned(A, 'reply');
    const edit = (payload: Record<string, unknown>) =>
      as(tokenA).post(`/api/linkedin/actions/${actionId}/body`).send(payload);
    await edit({ body: `Here: ${FILE_URL[type]}` }).expect(200);
    const refused = await edit({
      body: 'With the file',
      attachments: [REQUEST_MEDIA[type]]
    }).expect(422);
    expectRefusal(refused.body, 'content_type_unsupported', 'linkedin_reply', type);
    const row = await db
      .prepare('SELECT body, attachment_json FROM linkedin_actions WHERE id=?')
      .get<{ body: string; attachment_json: unknown }>(actionId);
    // Refused means nothing was written, not "saved without the file".
    expect(row).toEqual({ body: `Here: ${FILE_URL[type]}`, attachment_json: null });
  });

  it('takes exactly one DM attachment and refuses a second', async () => {
    const actionId = await planned(A, 'dm');
    const edit = (attachments: unknown[]) =>
      as(tokenA)
        .post(`/api/linkedin/actions/${actionId}/body`)
        .send({ body: 'Files', attachments });
    await edit([REQUEST_MEDIA.document]).expect(200);
    const refused = await edit([REQUEST_MEDIA.document, REQUEST_MEDIA.image]).expect(422);
    expectRefusal(refused.body, 'too_many_attachments', 'linkedin_message', null);
    expect(refused.body.index).toBeNull();
  });

  it('releases a held row by removing its attachment, and keeps it untouched when attachments are omitted', async () => {
    const actionId = await planned(A, 'dm', { url: FILE_URL.voice, mediaKind: 'voice' });
    await db
      .prepare("UPDATE linkedin_actions SET failure_kind='content_unsupported' WHERE id=?")
      .run(actionId);
    await as(tokenA)
      .post(`/api/linkedin/actions/${actionId}/body`)
      .send({ body: 'Words only' })
      .expect(200);
    let row = await db
      .prepare('SELECT attachment_json, failure_kind FROM linkedin_actions WHERE id=?')
      .get<{ attachment_json: unknown; failure_kind: string | null }>(actionId);
    expect(row).toMatchObject({
      failure_kind: 'content_unsupported',
      attachment_json: { mediaKind: 'voice' }
    });
    await as(tokenA)
      .post(`/api/linkedin/actions/${actionId}/body`)
      .send({ body: 'Words only', attachments: [] })
      .expect(200);
    row = await db
      .prepare('SELECT attachment_json, failure_kind FROM linkedin_actions WHERE id=?')
      .get<{ attachment_json: unknown; failure_kind: string | null }>(actionId);
    expect(row).toEqual({ attachment_json: null, failure_kind: null });
  });

  it('never edits another workspace row', async () => {
    const actionId = await planned(A, 'dm');
    await as(tokenB)
      .post(`/api/linkedin/actions/${actionId}/body`)
      .send({ body: 'Hijack', attachments: [REQUEST_MEDIA.document] })
      .expect(404);
  });
});

/* ---------------------------------------------------------------------------
 * Inbox reply.
 * ------------------------------------------------------------------------ */

describe('TRV-040 inbox reply', () => {
  it.each(RICH_CONTENT_TYPES)(
    'reply / %s: refused over HTTP before the thread is looked up',
    async (type) => {
      const refused = await as(tokenA)
        .post(`/api/linkedin/inbox/threads/${encodeURIComponent('2-nobody==')}/reply`)
        .send({ body: 'With a file', attachments: [REQUEST_MEDIA[type]] })
        .expect(422);
      expectRefusal(refused.body, 'content_type_unsupported', 'linkedin_reply', type);
      expect(refused.body.reason).toContain(RICH_CONTENT_MATRIX.linkedin_reply.cells[type].reason);
    }
  );

  it.each(RICH_CONTENT_TYPES)('reply / %s: the link-in-text alternative queues', async (type) => {
    await syncThreads(
      db,
      {
        workspaceId: A,
        threads: [
          {
            threadUrn: '2-maya-rich==',
            profileUrl: 'https://www.linkedin.com/in/maya-rich/',
            name: 'Maya Rich',
            lastMessageAt: '2026-08-04T09:30:00.000Z',
            snippet: 'Send me the deck',
            unread: true
          }
        ]
      },
      NOW
    );
    await expect(
      enqueueReply(
        db,
        {
          workspaceId: A,
          threadUrn: '2-maya-rich==',
          body: 'x',
          attachments: [REQUEST_MEDIA[type]]
        },
        NOW
      )
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof LinkedInApiError && error.code === 'content_type_unsupported'
    );
    const queued = await enqueueReply(
      db,
      { workspaceId: A, threadUrn: '2-maya-rich==', body: `Here it is: ${FILE_URL[type]}` },
      NOW
    );
    expect(queued.actionId).toBeTruthy();
    const row = await db
      .prepare('SELECT kind, attachment_json FROM linkedin_actions WHERE id=?')
      .get<{ kind: string; attachment_json: unknown }>(queued.actionId);
    expect(row).toEqual({ kind: 'reply', attachment_json: null });
  });
});

/* ---------------------------------------------------------------------------
 * LinkedIn post media: real bytes, real limits, workspace isolation.
 * ------------------------------------------------------------------------ */

describe('TRV-040 LinkedIn post media upload', () => {
  async function post(workspaceId: string, postId: string) {
    await createPost(
      db,
      {
        id: postId,
        workspaceId,
        blocks: [{ runs: [{ type: 'text', text: 'A post with pictures' }] }],
        status: 'draft',
        createdBy: `usr_${workspaceId}`
      },
      NOW
    );
    return postId;
  }
  const upload = (token: string, postId: string, mimeType: string, bytes: Buffer, name = 'file') =>
    as(token)
      .post(`/api/linkedin/posts/${postId}/media`)
      .set('Content-Type', mimeType)
      .set('X-Trevra-File-Name', name)
      .send(bytes);

  it('accepts images and GIFs exactly at 10 MB and refuses one byte more with attachment_too_large', async () => {
    const postId = await post(A, 'lipost_rich_size');
    await upload(tokenA, postId, 'image/png', Buffer.alloc(10 * MB, 1), 'at-limit.png').expect(201);
    const pngOver = await upload(tokenA, postId, 'image/png', Buffer.alloc(10 * MB + 1, 1)).expect(
      413
    );
    expectRefusal(pngOver.body, 'attachment_too_large', 'linkedin_post', 'image');
    await upload(tokenA, postId, 'image/gif', Buffer.from('GIF89a'), 'small.gif').expect(201);
    const gifOver = await upload(tokenA, postId, 'image/gif', Buffer.alloc(10 * MB + 1, 1)).expect(
      413
    );
    expectRefusal(gifOver.body, 'attachment_too_large', 'linkedin_post', 'gif');
    const stored = (await as(tokenA).get(`/api/linkedin/posts/${postId}`).expect(200)).body.post;
    expect(stored.media).toHaveLength(2);
  });

  it('takes nine images and refuses the tenth with too_many_attachments', async () => {
    const postId = await post(A, 'lipost_rich_count');
    for (let index = 0; index < RICH_CONTENT_MATRIX.linkedin_post.maxCount; index += 1)
      await upload(tokenA, postId, 'image/jpeg', Buffer.from([index + 1]), `${index}.jpg`).expect(
        201
      );
    const refused = await upload(tokenA, postId, 'image/jpeg', Buffer.from([42])).expect(400);
    expectRefusal(refused.body, 'too_many_attachments', 'linkedin_post', null);
  });

  it.each([
    ['video', 'video/mp4'],
    ['voice', 'audio/mp4'],
    ['document', 'application/pdf']
  ] as const)('refuses %s (%s) with content_type_unsupported', async (type, mimeType) => {
    const postId = await post(A, `lipost_rich_${type}`);
    const refused = await upload(tokenA, postId, mimeType, Buffer.from([1, 2, 3])).expect(415);
    expectRefusal(refused.body, 'content_type_unsupported', 'linkedin_post', type);
    expect(refused.body.reason).toContain(RICH_CONTENT_MATRIX.linkedin_post.cells[type].reason);
  });

  it('keeps uploaded files inside their workspace', async () => {
    const postId = await post(A, 'lipost_rich_private');
    const created = await upload(
      tokenA,
      postId,
      'image/png',
      Buffer.from([9, 8, 7]),
      'mine.png'
    ).expect(201);
    const imageId = created.body.post.media[0].id as string;
    const own = await as(tokenA).get(`/api/linkedin/posts/${postId}/media/${imageId}`).expect(200);
    expect(Buffer.from(own.body as Buffer)).toEqual(Buffer.from([9, 8, 7]));
    await as(tokenB).get(`/api/linkedin/posts/${postId}/media/${imageId}`).expect(404);
    await upload(tokenB, postId, 'image/png', Buffer.from([1])).expect(404);
    await request(app).get(`/api/linkedin/posts/${postId}/media/${imageId}`).expect(401);
    const count = await db
      .prepare('SELECT COUNT(*)::int AS total FROM linkedin_post_media WHERE post_id=?')
      .get<{ total: number }>(postId);
    expect(count?.total).toBe(1);
  });
});
