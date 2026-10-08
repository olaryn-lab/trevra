/**
 * Trevra capture signing with Web Crypto only, so it runs in a Cloudflare
 * Worker. The signed input is `<timestamp>.<idempotency-key>.<exact body>`,
 * HMAC-SHA256, hex, sent as `sha256=<hex>` (docs/lead-capture.md section 4).
 */
const encoder = new TextEncoder();

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// A type alias, not an interface: an alias gets an implicit index signature,
// so these headers are assignable to Node's IncomingHttpHeaders in the test.
export type SignedCaptureHeaders = {
  'content-type': 'application/json';
  'x-trevra-source': string;
  'x-trevra-timestamp': string;
  'x-trevra-idempotency-key': string;
  'x-trevra-signature': string;
};

export async function signCaptureRequest(input: {
  secret: string;
  sourceId: string;
  idempotencyKey: string;
  body: string;
  nowSeconds: number;
}): Promise<SignedCaptureHeaders> {
  const timestamp = String(Math.floor(input.nowSeconds));
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(input.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${timestamp}.${input.idempotencyKey}.${input.body}`)
  );
  return {
    'content-type': 'application/json',
    'x-trevra-source': input.sourceId,
    'x-trevra-timestamp': timestamp,
    'x-trevra-idempotency-key': input.idempotencyKey,
    'x-trevra-signature': `sha256=${hex(signature)}`
  };
}

/**
 * One logical submission per Turnstile token. A token is single-use, so a
 * browser double-submit fails the bot check rather than creating a second
 * person, and the Worker's own retry reuses this key with the same bytes.
 */
export async function idempotencyKeyForToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  return `turnstile:${hex(digest).slice(0, 48)}`;
}
