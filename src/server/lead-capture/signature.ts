import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

/**
 * The one implementation of Trevra's capture-source HMAC scheme.
 *
 * Signed bytes: `<X-Trevra-Timestamp>.<X-Trevra-Idempotency-Key>.<exact raw body>`,
 * HMAC-SHA256 with the source's active or (during rotation overlap) previous
 * secret, sent as `X-Trevra-Signature: sha256=<hex>`. Both public endpoints
 * (`/api/intake/v1/submissions` and `/api/intake/v1/citations`) and the
 * Cloudflare Worker test verify through this module, so the scheme cannot
 * drift between them.
 */
export const MAX_CAPTURE_BODY_BYTES = 128 * 1024;
export const MAX_CLOCK_SKEW_SECONDS = 5 * 60;
export const IDEMPOTENCY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;

export interface CaptureHeaders {
  sourceId: string;
  timestampRaw: string;
  idempotencyKey: string;
  signature: string;
}

export function readCaptureHeaders(headers: IncomingHttpHeaders): CaptureHeaders {
  return {
    sourceId: String(headers['x-trevra-source'] ?? '').trim(),
    timestampRaw: String(headers['x-trevra-timestamp'] ?? '').trim(),
    idempotencyKey: String(headers['x-trevra-idempotency-key'] ?? '').trim(),
    signature: String(headers['x-trevra-signature'] ?? '')
      .trim()
      .replace(/^sha256=/i, '')
  };
}

export interface CaptureProblem {
  status: 400 | 401;
  error: string;
}

/** Checks that need no secret, in the order intake has always applied them. */
export function captureHeaderProblem(
  headers: CaptureHeaders,
  nowSeconds: number
): CaptureProblem | null {
  if (!IDEMPOTENCY_RE.test(headers.idempotencyKey))
    return { status: 400, error: 'A valid X-Trevra-Idempotency-Key is required' };
  const timestamp = Number(headers.timestampRaw);
  if (!Number.isInteger(timestamp)) return { status: 401, error: 'Invalid capture timestamp' };
  if (Math.abs(nowSeconds - timestamp) > MAX_CLOCK_SKEW_SECONDS)
    return { status: 401, error: 'Capture timestamp is outside the replay window' };
  return null;
}

export function captureSignatureHex(
  secret: string,
  timestampRaw: string,
  idempotencyKey: string,
  rawBody: Buffer
): string {
  return createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${timestampRaw}.${idempotencyKey}.`, 'utf8'), rawBody]))
    .digest('hex');
}

function equalHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]+$/i.test(left) || !/^[a-f0-9]+$/i.test(right)) return false;
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

export function captureSignatureMatches(
  secrets: readonly string[],
  headers: CaptureHeaders,
  rawBody: Buffer
): boolean {
  return secrets.some((secret) =>
    equalHex(
      headers.signature,
      captureSignatureHex(secret, headers.timestampRaw, headers.idempotencyKey, rawBody)
    )
  );
}

export function rawCaptureBody(body: unknown): Buffer {
  return Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
}
