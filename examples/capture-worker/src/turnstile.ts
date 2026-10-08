/** https://developers.cloudflare.com/turnstile/get-started/server-side-validation/ */
export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const MAX_TOKEN_LENGTH = 2048;

/** The one fetch shape the Worker uses; tests pass a stub. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface TurnstileResult {
  success: boolean;
  errorCodes: string[];
  hostname: string | null;
}

export async function verifyTurnstile(input: {
  secret: string;
  token: string;
  remoteIp: string | null;
  /** Hostnames the token may have been issued on. An empty list fails closed. */
  expectedHostnames: readonly string[];
  fetchImpl: FetchLike;
}): Promise<TurnstileResult> {
  if (!input.token || input.token.length > MAX_TOKEN_LENGTH)
    return { success: false, errorCodes: ['missing-input-response'], hostname: null };
  const form = new FormData();
  form.append('secret', input.secret);
  form.append('response', input.token);
  if (input.remoteIp) form.append('remoteip', input.remoteIp);

  let outcome: { success?: unknown; hostname?: unknown; 'error-codes'?: unknown };
  try {
    const response = await input.fetchImpl(SITEVERIFY_URL, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(10_000)
    });
    outcome = (await response.json()) as typeof outcome;
  } catch {
    return { success: false, errorCodes: ['siteverify-unreachable'], hostname: null };
  }
  const hostname = typeof outcome.hostname === 'string' ? outcome.hostname : null;
  const errorCodes = Array.isArray(outcome['error-codes'])
    ? outcome['error-codes'].filter((code): code is string => typeof code === 'string')
    : [];
  if (outcome.success !== true) return { success: false, errorCodes, hostname };
  // A token minted on another site that uses the same site key must not pass.
  // An empty expectation list is a misconfiguration, so it refuses too.
  if (!hostname || !input.expectedHostnames.includes(hostname))
    return { success: false, errorCodes: ['hostname-mismatch'], hostname };
  return { success: true, errorCodes: [], hostname };
}
