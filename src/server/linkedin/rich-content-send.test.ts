import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { id, openDatabase, type Db } from '../db.js';
import {
  approveLinkedInAction,
  linkedinActionPolicyGate,
  listLinkedInActionReviews,
  reviewLinkedInAction
} from './action-policy.js';
import {
  SELECTORS,
  sendInMail,
  type LinkedInDriver,
  type LinkedInDriverResult,
  type LinkedInLocator,
  type LinkedInPage
} from './driver.js';
import { LinkedInApiError } from './errors.js';
import { createLeadList, importLeadCsv } from './lead-lists.js';
import { postgresLocalWorkerStore, runLinkedInLocalBatch } from './local-worker.js';
import { createManagedCampaign, startManagedCampaign } from './managed-campaigns.js';
import { runManagedCampaigns } from './runner.js';
import { upsertSeat } from './seats.js';
import { saveWorkflow } from './workflows.js';

/**
 * TRV-040 at the send boundary: what happens to content that got past (or
 * predates) the write paths. Real PostgreSQL for the ledger, the approval
 * hash, the local worker's store and the runner; a fake page for the driver.
 */

const WS = 'ws_rich_content_send';
const NOW = new Date('2026-08-03T09:00:00.000Z'); // Monday, inside the seat's window.
const MB = 1024 * 1024;
let db: Db;

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WS);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WS, 'Rich content send', NOW.toISOString());
  await upsertSeat(
    db,
    WS,
    {
      label: 'Owner',
      timezone: 'UTC',
      workingDays: [1, 2, 3, 4, 5],
      workStartMinute: 480,
      workEndMinute: 1080
    },
    new Date('2026-01-01T09:00:00.000Z')
  );
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WS);
  await db?.close();
});

async function plannedRow(
  kind: 'dm' | 'invite' | 'reply' | 'inmail',
  attachment: unknown,
  actionId = id('lact')
): Promise<string> {
  await db
    .prepare(
      `INSERT INTO linkedin_actions
         (id,workspace_id,seat_key,kind,target_ref,status,planned_for,source,body,subject,thread_urn,attachment_json,created_at)
       VALUES (?,?,'owner',?,?,'planned',?,'manual','Approved words',?,?,?::jsonb,?)`
    )
    .run(
      actionId,
      WS,
      kind,
      `https://www.linkedin.com/in/${actionId}/`,
      NOW.toISOString(),
      kind === 'inmail' ? 'Subject' : null,
      kind === 'reply' ? `2-${actionId}==` : null,
      attachment === null ? null : JSON.stringify(attachment),
      NOW.toISOString()
    );
  return actionId;
}

const PDF = { url: 'https://cdn.example.test/deck.pdf', name: 'deck.pdf', mediaKind: 'file' };
const VOICE = { url: 'https://cdn.example.test/note.m4a', name: 'note.m4a', mediaKind: 'voice' };

describe('TRV-040 exact approval covers the attachment', () => {
  it('invalidates an approval when the attachment changes, and refuses to approve forbidden content', async () => {
    const actionId = await plannedRow('dm', PDF);
    const first = (await reviewLinkedInAction(db, WS, actionId))!;
    expect(first.richContent).toBeNull();
    expect(first.hasAttachments).toBe(true);
    await approveLinkedInAction(db, WS, actionId, first.contentHash, 'owner', NOW);
    expect((await linkedinActionPolicyGate(db, WS, actionId)).allowed).toBe(true);

    // Same words, same person, a different file: the approval no longer applies.
    await db
      .prepare('UPDATE linkedin_actions SET attachment_json=?::jsonb WHERE workspace_id=? AND id=?')
      .run(JSON.stringify({ ...PDF, url: 'https://cdn.example.test/other.pdf' }), WS, actionId);
    const changed = (await reviewLinkedInAction(db, WS, actionId))!;
    expect(changed.contentHash).not.toBe(first.contentHash);
    expect(changed.approved).toBe(false);
    expect((await linkedinActionPolicyGate(db, WS, actionId)).allowed).toBe(false);
    await expect(
      approveLinkedInAction(db, WS, actionId, first.contentHash, 'owner', NOW)
    ).rejects.toThrow('changed since review');

    // And a file the channel refuses cannot be approved at all.
    await db
      .prepare('UPDATE linkedin_actions SET attachment_json=?::jsonb WHERE workspace_id=? AND id=?')
      .run(JSON.stringify(VOICE), WS, actionId);
    const forbidden = (await reviewLinkedInAction(db, WS, actionId))!;
    expect(forbidden.richContent).toMatchObject({
      code: 'content_type_unsupported',
      channel: 'linkedin_message',
      contentType: 'voice'
    });
    await expect(
      approveLinkedInAction(db, WS, actionId, forbidden.contentHash, 'owner', NOW)
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof LinkedInApiError &&
        error.status === 422 &&
        error.code === 'content_type_unsupported'
    );
    const gate = await linkedinActionPolicyGate(db, WS, actionId);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/held: Voice attachments are not supported/);
    expect(
      (await listLinkedInActionReviews(db, WS)).find((row) => row.actionId === actionId)
        ?.richContent
    ).toMatchObject({ contentType: 'voice' });
  });
});

describe('TRV-040 legacy planned actions at the local worker', () => {
  it('holds rows whose attachment the channel refuses: nothing opened, nothing sent, nothing dropped', async () => {
    const legacy = {
      invite: await plannedRow('invite', PDF),
      voice: await plannedRow('dm', VOICE),
      pair: await plannedRow('dm', [PDF, PDF]),
      reply: await plannedRow('reply', PDF),
      unreadable: await plannedRow('dm', 'not json at all')
    };
    const control = await plannedRow('dm', null);
    const calls: Array<{ method: string; target: string }> = [];
    const sent = (method: string) => async (_page: LinkedInPage, target: string) => {
      calls.push({ method, target });
      return { ok: true, externalRef: target, failureKind: null } satisfies LinkedInDriverResult;
    };
    const logs: string[] = [];
    const run = () =>
      runLinkedInLocalBatch(postgresLocalWorkerStore(db, WS, 'owner'), {
        driver: {
          sendInvite: sent('sendInvite'),
          sendDm: sent('sendDm'),
          sendReply: sent('sendReply')
        } as unknown as LinkedInDriver,
        page: {} as LinkedInPage,
        now: () => NOW,
        sleep: async () => {},
        log: (message) => logs.push(message),
        maxActions: 10,
        evaluate: async () => ({
          allowed: true,
          reason: null,
          checks: [],
          automationMode: 'prepare-only',
          automationReason: 'Driver double; not a live acceptance run'
        })
      });

    const result = await run();
    expect(calls).toEqual([
      { method: 'sendDm', target: `https://www.linkedin.com/in/${control}/` }
    ]);
    expect(result.executed).toBe(1);
    expect(result.blocked).toBe(Object.keys(legacy).length);

    const rows = await db
      .prepare(
        `SELECT id, status, failure_kind, claimed_at, attachment_json FROM linkedin_actions
         WHERE workspace_id=? AND id IN (?,?,?,?,?)`
      )
      .all<{
        id: string;
        status: string;
        failure_kind: string | null;
        claimed_at: string | null;
        attachment_json: unknown;
      }>(WS, ...Object.values(legacy));
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row, row.id).toMatchObject({
        status: 'planned',
        failure_kind: 'content_unsupported',
        claimed_at: null
      });
      expect(row.attachment_json, row.id).not.toBeNull();
    }
    expect(logs.filter((line) => line.includes('held action'))).toHaveLength(5);
    expect(logs.find((line) => line.includes(legacy.invite))).toMatch(
      /link-only on LinkedIn invitation note/
    );

    // Re-checked on every pass, still held, still not sent.
    await run();
    expect(calls).toHaveLength(1);
  });
});

describe('TRV-040 runner hold on a legacy step snapshot', () => {
  it('keeps the member on the step with the reason instead of planning the action', async () => {
    const list = await createLeadList(db, { workspaceId: WS, name: 'Legacy snapshot' }, NOW);
    await importLeadCsv(
      db,
      {
        workspaceId: WS,
        listId: list.id,
        csv: 'First Name,Last Name,Company,Email,LinkedIn URL\nMaya,Legacy,Acme,maya-legacy@test.test,https://www.linkedin.com/in/maya-legacy-snapshot\n'
      },
      NOW
    );
    const workflow = await saveWorkflow(
      db,
      {
        workspaceId: WS,
        name: 'Invite then stop',
        steps: [
          {
            id: 'invite',
            action: 'connection_request',
            delayBefore: { amount: 0, unit: 'hours' },
            config: { variants: [{ id: 'a', body: 'Hi {{first_name}}', weight: 100 }] }
          }
        ]
      },
      NOW
    );
    const made = await createManagedCampaign(
      db,
      { workspaceId: WS, name: 'Legacy snapshot', leadListId: list.id, workflowId: workflow.id },
      NOW
    );
    await startManagedCampaign(db, WS, made.campaign.id, NOW);
    // What a pre-matrix save could leave behind: the invite variant carries a file.
    const inject = (
      column: 'sequence_json' | 'workflow_snapshot_json',
      table: string,
      key: string
    ) =>
      db
        .prepare(
          `UPDATE ${table} SET ${column} = jsonb_set(jsonb_set(${column},
             '{steps,0,config,variants,0,attachmentUrl}', to_jsonb(?::text)),
             '{steps,0,config,variants,0,mediaKind}', '"file"'::jsonb)
           WHERE workspace_id=? AND ${key}=? AND ${column} IS NOT NULL`
        )
        .run(PDF.url, WS, made.campaign.id);
    await inject('sequence_json', 'linkedin_campaigns', 'id');
    await inject('workflow_snapshot_json', 'linkedin_campaign_members', 'campaign_id');

    const result = await runManagedCampaigns(db, WS, NOW);
    expect(result.membersBlocked).toBeGreaterThanOrEqual(1);
    const planned = await db
      .prepare('SELECT COUNT(*)::int AS total FROM linkedin_actions WHERE workspace_id=?')
      .get<{ total: number }>(WS);
    expect(planned?.total).toBe(0);
    const member = await db
      .prepare(
        'SELECT current_step_id, branch_state_json, workflow_snapshot_json FROM linkedin_campaign_members WHERE workspace_id=? AND campaign_id=?'
      )
      .get<{
        current_step_id: string | null;
        branch_state_json: Record<string, { reason: string; code: string }>;
        workflow_snapshot_json: {
          steps: Array<{ config: { variants: Array<Record<string, unknown>> } }>;
        };
      }>(WS, made.campaign.id);
    expect(member?.branch_state_json['blocked:invite']).toMatchObject({
      code: 'content_type_unsupported',
      reason: expect.stringContaining('link-only on LinkedIn invitation note')
    });
    // Held, not stripped: the snapshot still names the file for a person to deal with.
    expect(member?.workflow_snapshot_json.steps[0]!.config.variants[0]!.attachmentUrl).toBe(
      PDF.url
    );
  });
});

describe('TRV-040 composer upload at the send boundary', () => {
  const TARGET = 'https://www.linkedin.com/in/maya-smith/';
  function fakePage() {
    const counts: Record<string, number> = {
      [SELECTORS.inmailButton]: 1,
      [SELECTORS.inmailSubject]: 1,
      [SELECTORS.inmailComposeBox]: 1,
      [SELECTORS.inmailSendButton]: 1,
      [SELECTORS.inmailAttachmentInput]: 1,
      [SELECTORS.inmailAttachmentPreview]: 1
    };
    const uploaded: Array<{ name: string; mimeType: string; size: number }> = [];
    const clicked: string[] = [];
    const locator = (selector: string): LinkedInLocator => ({
      count: async () => counts[selector] ?? 0,
      first: () => locator(selector),
      click: async () => {
        clicked.push(selector);
      },
      fill: async () => undefined,
      setInputFiles: async (file) => {
        uploaded.push({ name: file.name, mimeType: file.mimeType, size: file.buffer.byteLength });
      },
      textContent: async () => null
    });
    let current = 'https://www.linkedin.com/feed/';
    const page: LinkedInPage = {
      goto: async (url) => {
        current = url;
        return null;
      },
      url: () => current,
      locator,
      waitForTimeout: async () => undefined
    };
    return { page, uploaded, clicked };
  }
  const serve = (bytes: number, headers: Record<string, string>) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(bytes), { status: 200, headers }))
    );
  const send = (page: LinkedInPage, url: string, name?: string) =>
    sendInMail(page, TARGET, 'Subject', 'Approved body', {
      attachment: { url, ...(name ? { name } : {}), mediaKind: 'file' }
    });

  it('uploads a file of exactly 10 MB and sends after the preview', async () => {
    serve(10 * MB, { 'content-type': 'application/pdf', 'content-length': String(10 * MB) });
    const fake = fakePage();
    const result = await send(fake.page, 'https://files.example.test/deck.pdf');
    expect(result).toMatchObject({ ok: true, failureKind: null });
    expect(fake.uploaded).toEqual([
      { name: 'deck.pdf', mimeType: 'application/pdf', size: 10 * MB }
    ]);
    expect(fake.clicked).toContain(SELECTORS.inmailSendButton);
  });

  it('refuses one byte more, declared or not, without uploading or sending', async () => {
    const declaredAndUndeclared: Array<Record<string, string>> = [
      { 'content-type': 'application/pdf', 'content-length': String(10 * MB + 1) },
      { 'content-type': 'application/pdf' }
    ];
    for (const headers of declaredAndUndeclared) {
      serve(10 * MB + 1, headers);
      const fake = fakePage();
      const result = await send(fake.page, 'https://files.example.test/deck.pdf');
      expect(result).toMatchObject({ ok: false, failureKind: 'compose_unavailable' });
      expect(result.detail).toMatch(
        /must be 10 MB or smaller; this one is 10485761 bytes\. The text draft was not sent\./
      );
      expect(fake.uploaded).toEqual([]);
      expect(fake.clicked).not.toContain(SELECTORS.inmailSendButton);
    }
  });

  it('checks the downloaded type against the row before uploading', async () => {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [
        {
          'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        },
        /accepts PNG, JPEG, GIF or PDF attachments/
      ],
      [{ 'content-type': 'video/mp4' }, /Video attachments are not supported on LinkedIn InMail/],
      [{}, /Neither the download nor the file name says what type/]
    ];
    for (const [headers, message] of cases) {
      serve(3, headers);
      const fake = fakePage();
      const result = await send(fake.page, 'https://files.example.test/download');
      expect(result).toMatchObject({ ok: false, failureKind: 'compose_unavailable' });
      expect(result.detail).toMatch(message);
      expect(fake.uploaded).toEqual([]);
      expect(fake.clicked).not.toContain(SELECTORS.inmailSendButton);
    }
  });
});
