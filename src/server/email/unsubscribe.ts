import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db.js';
import { normalizeContactEmail } from '../lead-capture/people.js';
import { createSuppression } from '../suppressions.js';
import { publicEmailOrigin } from './public-origin.js';

/*
 * RFC 8058 one-click unsubscribe for outreach email.
 *
 * A token is `<gtm_deliveries.id>.<mac>`. The HMAC binds workspace, delivery
 * and recipient, so a token can never be redeemed against another tenant's row
 * or another recipient. The key is derived from TREVRA_SECRETS_KEY, so there is
 * no new secret to store. TREVRA_SECRETS_KEY_PREVIOUS keeps links in sent mail
 * working through a rotation.
 *
 * This module must not import integration-service.ts: integration-service
 * imports it to stamp the headers onto outgoing mail.
 */
// lc-debt: completing a TREVRA_SECRETS_KEY rotation (removing _PREVIOUS) retires the one-click links in mail already sent; upgrade path: a dedicated long-lived unsubscribe key with its own previous-key list.

const KEY_INFO = 'trevra-email-unsubscribe-v1';
const DELIVERY_ID_PATTERN = /^del_[0-9a-f]{16}$/;
const TOKEN_PATTERN = /^(del_[0-9a-f]{16})\.([A-Za-z0-9_-]{43})$/;

/** Finds a Trevra unsubscribe token in a mailto subject, wherever the client put it. */
export const UNSUBSCRIBE_SUBJECT_PATTERN =
  /\bunsubscribe\s+(del_[0-9a-f]{16}\.[A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/i;

export type UnsubscribeSource = 'email_one_click_unsubscribe' | 'email_mailto_unsubscribe';

function deriveKey(secret: string): Buffer {
  return createHmac('sha256', secret).update(KEY_INFO).digest();
}

function unsubscribeKeys(env: NodeJS.ProcessEnv): Buffer[] {
  return [env.TREVRA_SECRETS_KEY, env.TREVRA_SECRETS_KEY_PREVIOUS]
    .map((value) => value?.trim() ?? '')
    .filter(Boolean)
    .map(deriveKey);
}

function tokenMac(key: Buffer, workspaceId: string, deliveryId: string, recipient: string): string {
  // A JSON array keeps field boundaries unambiguous whatever the fields contain.
  return createHmac('sha256', key)
    .update(JSON.stringify(['v1', workspaceId, deliveryId, recipient.trim().toLowerCase()]))
    .digest('base64url');
}

/** RFC 8058 requires the one-click target to be HTTPS. */
export function unsubscribeOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const origin = publicEmailOrigin(env);
  return origin?.startsWith('https://') ? origin : null;
}

export function unsubscribeConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.TREVRA_SECRETS_KEY?.trim()) && unsubscribeOrigin(env) !== null;
}

export function unsubscribeToken(
  input: { workspaceId: string; deliveryId: string; recipient: string },
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const secret = env.TREVRA_SECRETS_KEY?.trim();
  if (!secret || !DELIVERY_ID_PATTERN.test(input.deliveryId)) return null;
  return `${input.deliveryId}.${tokenMac(deriveKey(secret), input.workspaceId, input.deliveryId, input.recipient)}`;
}

export function listUnsubscribeHeaders(input: {
  token: string;
  origin: string;
  mailbox: string | null;
}): string[] {
  const targets = [`<${input.origin}/u/${input.token}>`];
  if (input.mailbox) {
    targets.push(
      `<mailto:${input.mailbox}?subject=${encodeURIComponent(`unsubscribe ${input.token}`)}>`
    );
  }
  return [
    `List-Unsubscribe: ${targets.join(', ')}`,
    'List-Unsubscribe-Post: List-Unsubscribe=One-Click'
  ];
}

/**
 * Headers for one outreach delivery, or [] when unsubscribe is not configured.
 * The mailto target is offered only while the designated inbound mailbox is
 * really being read; otherwise a mailto unsubscribe would land in an inbox
 * nothing processes.
 */
export async function outreachUnsubscribeHeaders(
  db: Db,
  input: { workspaceId: string; deliveryId: string; recipient: string },
  env: NodeJS.ProcessEnv = process.env
): Promise<string[]> {
  const origin = unsubscribeOrigin(env);
  const token = origin ? unsubscribeToken(input, env) : null;
  if (!origin || !token) return [];
  const inbound = await db
    .prepare(
      `SELECT m.address FROM email_inbound_mailboxes m
       JOIN connections c ON c.workspace_id=m.workspace_id AND c.id=m.connection_id
       WHERE m.workspace_id=? AND m.sync_status='syncing' AND c.status='connected'`
    )
    .get<{ address: string }>(input.workspaceId);
  return listUnsubscribeHeaders({ token, origin, mailbox: inbound?.address ?? null });
}

export interface UnsubscribeDelivery {
  id: string;
  workspaceId: string;
  recipient: string;
  sourceType: string;
  sourceId: string;
}

export async function findUnsubscribeDelivery(
  db: Db,
  token: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<UnsubscribeDelivery | null> {
  const match = TOKEN_PATTERN.exec(token.trim());
  if (!match) return null;
  const deliveryId = match[1]!;
  const presented = Buffer.from(match[2]!, 'utf8');
  // Deliberately not scoped by workspace: the token is the only tenant evidence
  // a recipient's mail client carries. The HMAC check below binds this row's
  // own workspace, id and recipient, so a valid token cannot name another
  // tenant's delivery.
  const row = await db
    .prepare(
      `SELECT id,workspace_id,recipient,source_type,source_id FROM gtm_deliveries
       WHERE id=? AND channel='email' AND purpose='outreach'`
    )
    .get<{
      id: string;
      workspace_id: string;
      recipient: string;
      source_type: string;
      source_id: string;
    }>(deliveryId);
  if (!row) return null;
  for (const key of unsubscribeKeys(env)) {
    const expected = Buffer.from(tokenMac(key, row.workspace_id, row.id, row.recipient), 'utf8');
    if (expected.length === presented.length && timingSafeEqual(expected, presented)) {
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        recipient: row.recipient,
        sourceType: row.source_type,
        sourceId: row.source_id
      };
    }
  }
  return null;
}

/**
 * The Person an outreach delivery was approved for: the personId in its
 * gtm.email-outreach run's input (the delivery's source id is the run's
 * idempotency key). Null, so the suppression stays email-only, when the
 * delivery came from anywhere else, the run or Person is gone, or the
 * recipient's address already belongs to a different Person.
 */
async function unsubscribePersonId(db: Db, delivery: UnsubscribeDelivery): Promise<string | null> {
  if (delivery.sourceType !== 'email_outreach') return null;
  const run = await db
    .prepare(
      `SELECT r.input_json->>'personId' AS person_id FROM playbook_runs r
       JOIN contacts p ON p.workspace_id=r.workspace_id AND p.id=r.input_json->>'personId'
       WHERE r.workspace_id=? AND r.playbook_key='gtm.email-outreach'
         AND r.input_json->>'idempotencyKey'=?
       LIMIT 2`
    )
    .all<{ person_id: string }>(delivery.workspaceId, delivery.sourceId);
  if (run.length !== 1) return null;
  const personId = run[0]!.person_id;
  const owner = await db
    .prepare('SELECT id FROM contacts WHERE workspace_id=? AND email_normalized=? LIMIT 1')
    .get<{ id: string }>(delivery.workspaceId, normalizeContactEmail(delivery.recipient));
  return owner && owner.id !== personId ? null : personId;
}

/**
 * Suppress the delivery's recipient for email in the delivery's workspace.
 * `workspaceId`, when given (the mailto path knows which inbox received the
 * request), must match the token's workspace or nothing happens. Repeating it
 * is harmless: suppressions and campaign events are idempotent.
 */
export async function applyUnsubscribeToken(
  db: Db,
  token: string,
  input: { source: UnsubscribeSource; workspaceId?: string },
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env
): Promise<{ applied: boolean; workspaceId: string | null }> {
  const delivery = await findUnsubscribeDelivery(db, token, env);
  if (!delivery) return { applied: false, workspaceId: null };
  if (input.workspaceId && input.workspaceId !== delivery.workspaceId) {
    return { applied: false, workspaceId: null };
  }
  await createSuppression(
    db,
    {
      workspaceId: delivery.workspaceId,
      channel: 'email',
      personId: await unsubscribePersonId(db, delivery),
      email: delivery.recipient,
      reason: 'Recipient unsubscribed from email',
      source: input.source,
      sourceRef: delivery.id,
      actorType: 'system'
    },
    now
  );
  if (delivery.sourceType === 'campaign_email') {
    // recordCampaignEmailEvent may add a second suppression, of the contact's
    // current email. That is intended and fail-safe: it only ever suppresses more.
    // Dynamic: campaign-channels imports integration-service, which imports this module.
    const { recordCampaignEmailEvent } = await import('../linkedin/campaign-channels.js');
    await recordCampaignEmailEvent(
      db,
      delivery.workspaceId,
      {
        channelActionId: delivery.sourceId,
        eventKind: 'unsubscribe',
        providerEventId: `unsubscribe:${delivery.id}`,
        metadata: { source: input.source }
      },
      now
    );
  }
  return { applied: true, workspaceId: delivery.workspaceId };
}

export type UnsubscribePageState = 'confirm' | 'done' | 'invalid' | 'error';

const PAGE_COPY: Record<UnsubscribePageState, { title: string; body: string }> = {
  confirm: {
    title: 'Unsubscribe from these emails',
    body: 'Confirm, and this address will not receive further outreach email from this sender.'
  },
  done: {
    title: 'You are unsubscribed',
    body: 'This address will not receive further outreach email from this sender. You can close this page.'
  },
  invalid: {
    title: 'This unsubscribe link is not valid',
    body: 'It may have been copied incompletely. Reply to the email with the word "unsubscribe" and the sender will stop.'
  },
  error: {
    title: 'Your request was not recorded',
    body: 'Something went wrong on our side. Please try again in a minute.'
  }
};

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * A page with no script, so a link scanner that fetches it can do nothing. Only
 * the explicit POST (the button, or a mail client's RFC 8058 one-click POST)
 * unsubscribes.
 */
export function renderUnsubscribePage(state: UnsubscribePageState, token?: string): string {
  const copy = PAGE_COPY[state];
  const title = escapeHtml(copy.title);
  // The token pattern admits only [A-Za-z0-9_.-]; escaping it is defence in depth.
  const form =
    state === 'confirm' && token && TOKEN_PATTERN.test(token)
      ? `<form method="post" action="/u/${escapeHtml(token)}"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button type="submit">Unsubscribe</button></form>`
      : '';
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    `<title>${title}</title>`,
    '<style>',
    ':root{color-scheme:light dark}',
    'body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:Canvas;color:CanvasText}',
    'main{max-width:32rem;margin:15vh auto 0;padding:0 16px}',
    'h1{font-size:1.375rem;line-height:1.3;margin:0 0 .5rem}',
    'p{margin:0 0 1.25rem}',
    'button{min-height:44px;padding:0 1.25rem;font:inherit;border-radius:6px;border:1px solid ButtonBorder;background:ButtonFace;color:ButtonText;cursor:pointer}',
    'button:focus-visible{outline:2px solid Highlight;outline-offset:2px}',
    '</style></head>',
    `<body><main><h1>${title}</h1><p>${escapeHtml(copy.body)}</p>${form}</main></body></html>`
  ].join('\n');
}
