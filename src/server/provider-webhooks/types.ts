import type { Db } from '../db.js';

/** Providers with an observe-only inbound webhook. Migration 130 CHECKs this list. */
export const WEBHOOK_PROVIDERS = ['stripe', 'calcom'] as const;
export type WebhookProvider = (typeof WEBHOOK_PROVIDERS)[number];

export function isWebhookProvider(value: unknown): value is WebhookProvider {
  return typeof value === 'string' && (WEBHOOK_PROVIDERS as readonly string[]).includes(value);
}

export interface ProviderWebhookEndpoint {
  id: string;
  workspaceId: string;
  provider: WebhookProvider;
  status: 'active' | 'disabled';
  createdByUserId: string | null;
  lastSeenAt: string | null;
  acceptedCount: number;
  rejectedCount: number;
  createdAt: string;
  updatedAt: string;
}

export type WebhookHeaders = Record<string, string | string[] | undefined>;

export type ProviderWebhookVerification =
  | { ok: true; eventId: string; eventType: string; payload: unknown }
  | { ok: false; status: number; error: string };

export interface ProviderWebhookEvent {
  eventId: string;
  eventType: string;
  payload: unknown;
}

/**
 * One provider's half of an inbound webhook. `verify` sees the exact raw bytes
 * and must not touch the database; `handle` runs only after verification and
 * after the event was claimed in `webhook_events`, and must be idempotent.
 */
export interface ProviderWebhookVerifier {
  provider: WebhookProvider;
  /** Shape check for the secret an owner pastes, so a typo fails at setup. */
  secretPattern?: RegExp;
  verify(
    rawBody: Buffer,
    headers: WebhookHeaders,
    secret: string,
    now: Date
  ): ProviderWebhookVerification;
  handle(
    db: Db,
    endpoint: ProviderWebhookEndpoint,
    event: ProviderWebhookEvent,
    now: Date
  ): Promise<{ handled: boolean }>;
}

export class ProviderWebhookError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
  }
}
