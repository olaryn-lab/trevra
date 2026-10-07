import { randomBytes } from 'node:crypto';
import type { Db } from '../db.js';
import { appendDomainEvent } from '../control-plane/events.js';
import {
  openSecret,
  sealSecret,
  secretsConfigured,
  type SecretContext
} from '../secrets/crypto.js';
import { getProviderVerifier } from './registry.js';
import {
  ProviderWebhookError,
  isWebhookProvider,
  type ProviderWebhookEndpoint,
  type WebhookProvider
} from './types.js';

const ENDPOINT_ID_RE = /^pwh_[a-f0-9]{24}$/;
const MAX_SECRET_LENGTH = 500;
const COLUMNS =
  'id,workspace_id,provider,status,created_by_user_id,last_seen_at,accepted_count,rejected_count,created_at,updated_at';

/** Unguessable, but not the credential: the sealed signing secret is. */
export function draftProviderWebhookEndpointId(): string {
  return `pwh_${randomBytes(12).toString('hex')}`;
}

export function isProviderWebhookEndpointId(value: string): boolean {
  return ENDPOINT_ID_RE.test(value);
}

export function providerWebhookPath(provider: WebhookProvider, endpointId: string): string {
  return `/api/hooks/v1/${provider}/${endpointId}`;
}

export function withProviderWebhookPath(
  endpoint: ProviderWebhookEndpoint
): ProviderWebhookEndpoint & { path: string } {
  return { ...endpoint, path: providerWebhookPath(endpoint.provider, endpoint.id) };
}

export function providerWebhookSecretContext(
  workspaceId: string,
  endpointId: string,
  provider: WebhookProvider
): SecretContext {
  return { store: 'provider_webhook_endpoints', workspaceId, seatKey: endpointId, kind: provider };
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return new Date(String(value)).toISOString();
}

function toEndpoint(row: Record<string, unknown>): ProviderWebhookEndpoint {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    provider: String(row.provider) as WebhookProvider,
    status: String(row.status) === 'active' ? 'active' : 'disabled',
    createdByUserId: row.created_by_user_id ? String(row.created_by_user_id) : null,
    lastSeenAt: iso(row.last_seen_at),
    acceptedCount: Number(row.accepted_count ?? 0),
    rejectedCount: Number(row.rejected_count ?? 0),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!
  };
}

export async function readProviderWebhookSecret(
  db: Db,
  endpoint: Pick<ProviderWebhookEndpoint, 'id' | 'workspaceId' | 'provider'>
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT secret_ciphertext,secret_iv,secret_auth_tag,secret_key_version,secret_key_id
       FROM provider_webhook_endpoints WHERE workspace_id=? AND id=?`
    )
    .get<Record<string, unknown>>(endpoint.workspaceId, endpoint.id);
  if (!row) return null;
  return openSecret(
    {
      ciphertext: Buffer.from(row.secret_ciphertext as Buffer),
      iv: Buffer.from(row.secret_iv as Buffer),
      authTag: Buffer.from(row.secret_auth_tag as Buffer),
      keyVersion: Number(row.secret_key_version),
      keyId: row.secret_key_id ? String(row.secret_key_id) : null
    },
    providerWebhookSecretContext(endpoint.workspaceId, endpoint.id, endpoint.provider)
  );
}

/**
 * Store an endpoint and its sealed signing secret. Idempotent on `endpointId`:
 * the same workspace, provider and secret returns the existing endpoint; any
 * other combination is a 409, so an id can never be claimed across workspaces.
 */
export async function createProviderWebhookEndpoint(
  db: Db,
  input: {
    workspaceId: string;
    actorUserId: string | null;
    provider: WebhookProvider;
    signingSecret: string;
    endpointId?: string;
  },
  now: Date = new Date()
): Promise<ProviderWebhookEndpoint> {
  if (!secretsConfigured())
    throw new ProviderWebhookError(
      'Webhook signing secrets need TREVRA_SECRETS_KEY on this deployment. Configure secret custody first.',
      409
    );
  if (!isWebhookProvider(input.provider))
    throw new ProviderWebhookError('Unknown webhook provider.', 400);
  const verifier = getProviderVerifier(input.provider);
  if (!verifier)
    throw new ProviderWebhookError(
      `${input.provider} webhooks are not available on this deployment.`,
      400
    );
  const secret = input.signingSecret.trim();
  if (!secret || secret.length > MAX_SECRET_LENGTH)
    throw new ProviderWebhookError('A signing secret is required.', 400);
  if (verifier.secretPattern && !verifier.secretPattern.test(secret))
    throw new ProviderWebhookError("That does not look like this provider's signing secret.", 400);
  const endpointId = input.endpointId?.trim() || draftProviderWebhookEndpointId();
  if (!isProviderWebhookEndpointId(endpointId))
    throw new ProviderWebhookError('Invalid webhook endpoint id.', 400);

  const sealed = sealSecret(
    secret,
    providerWebhookSecretContext(input.workspaceId, endpointId, input.provider)
  );
  const at = now.toISOString();
  return db.transaction(async (tx) => {
    const inserted = await tx
      .prepare(
        `INSERT INTO provider_webhook_endpoints (
           id,workspace_id,provider,status,secret_ciphertext,secret_iv,secret_auth_tag,
           secret_key_version,secret_key_id,created_by_user_id,created_at,updated_at
         ) VALUES (?,?,?,'active',?,?,?,?,?,?,?,?)
         ON CONFLICT (id) DO NOTHING
         RETURNING ${COLUMNS}`
      )
      .get<Record<string, unknown>>(
        endpointId,
        input.workspaceId,
        input.provider,
        sealed.ciphertext,
        sealed.iv,
        sealed.authTag,
        sealed.keyVersion,
        sealed.keyId,
        input.actorUserId,
        at,
        at
      );
    if (inserted) {
      await appendDomainEvent(tx, {
        workspaceId: input.workspaceId,
        streamType: 'provider_webhook_endpoint',
        streamId: endpointId,
        eventType: 'provider_webhook_endpoint.created',
        actorType: 'human',
        actorId: input.actorUserId,
        payload: { provider: input.provider }
      });
      return toEndpoint(inserted);
    }
    const existing = await tx
      .prepare(`SELECT ${COLUMNS} FROM provider_webhook_endpoints WHERE id=?`)
      .get<Record<string, unknown>>(endpointId);
    if (
      !existing ||
      String(existing.workspace_id) !== input.workspaceId ||
      String(existing.provider) !== input.provider
    )
      throw new ProviderWebhookError('This webhook endpoint id is already in use.', 409);
    const endpoint = toEndpoint(existing);
    if ((await readProviderWebhookSecret(tx, endpoint)) !== secret)
      throw new ProviderWebhookError(
        'This endpoint already has a different signing secret. Remove it and connect again.',
        409
      );
    return endpoint;
  });
}

/** Global lookup by URL id: only the inbound route uses it, to decide the workspace. */
export async function getProviderWebhookEndpointById(
  db: Db,
  endpointId: string
): Promise<ProviderWebhookEndpoint | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM provider_webhook_endpoints WHERE id=?`)
    .get<Record<string, unknown>>(endpointId);
  return row ? toEndpoint(row) : null;
}

export async function listProviderWebhookEndpoints(
  db: Db,
  workspaceId: string
): Promise<ProviderWebhookEndpoint[]> {
  const rows = await db
    .prepare(
      `SELECT ${COLUMNS} FROM provider_webhook_endpoints
       WHERE workspace_id=? ORDER BY created_at DESC,id DESC`
    )
    .all<Record<string, unknown>>(workspaceId);
  return rows.map(toEndpoint);
}

export async function setProviderWebhookEndpointStatus(
  db: Db,
  input: {
    workspaceId: string;
    endpointId: string;
    status: 'active' | 'disabled';
    actorUserId: string | null;
  },
  now: Date = new Date()
): Promise<ProviderWebhookEndpoint | null> {
  return db.transaction(async (tx) => {
    const changed = await tx
      .prepare(
        `UPDATE provider_webhook_endpoints SET status=?,updated_at=?
         WHERE workspace_id=? AND id=? AND status<>?
         RETURNING ${COLUMNS}`
      )
      .get<Record<string, unknown>>(
        input.status,
        now.toISOString(),
        input.workspaceId,
        input.endpointId,
        input.status
      );
    if (changed) {
      await appendDomainEvent(tx, {
        workspaceId: input.workspaceId,
        streamType: 'provider_webhook_endpoint',
        streamId: input.endpointId,
        eventType: 'provider_webhook_endpoint.status_changed',
        actorType: 'human',
        actorId: input.actorUserId,
        payload: { status: input.status }
      });
      return toEndpoint(changed);
    }
    const current = await tx
      .prepare(`SELECT ${COLUMNS} FROM provider_webhook_endpoints WHERE workspace_id=? AND id=?`)
      .get<Record<string, unknown>>(input.workspaceId, input.endpointId);
    return current ? toEndpoint(current) : null;
  });
}

/** The closer for this state. Idempotent: removing a missing endpoint is a no-op. */
export async function deleteProviderWebhookEndpoint(
  db: Db,
  input: { workspaceId: string; endpointId: string; actorUserId: string | null }
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const removed = await tx
      .prepare(
        'DELETE FROM provider_webhook_endpoints WHERE workspace_id=? AND id=? RETURNING id,provider'
      )
      .get<{ id: string; provider: string }>(input.workspaceId, input.endpointId);
    if (!removed) return false;
    await appendDomainEvent(tx, {
      workspaceId: input.workspaceId,
      streamType: 'provider_webhook_endpoint',
      streamId: input.endpointId,
      eventType: 'provider_webhook_endpoint.removed',
      actorType: 'human',
      actorId: input.actorUserId,
      payload: { provider: removed.provider }
    });
    return true;
  });
}

export async function recordProviderWebhookAccepted(
  db: Db,
  endpointId: string,
  now: Date
): Promise<void> {
  await db
    .prepare(
      'UPDATE provider_webhook_endpoints SET accepted_count=accepted_count+1,last_seen_at=? WHERE id=?'
    )
    .run(now.toISOString(), endpointId);
}

export async function recordProviderWebhookRejected(
  db: Db,
  endpointId: string,
  now: Date
): Promise<void> {
  await db
    .prepare(
      'UPDATE provider_webhook_endpoints SET rejected_count=rejected_count+1,last_seen_at=? WHERE id=?'
    )
    .run(now.toISOString(), endpointId);
}
