/**
 * What the sign-in screen does with the `auth_error` value Authward puts on
 * `/login` (Authward docs/product-integration-guide.md, the product `/login`
 * contract).
 *
 * `interaction_expired` is the one value Authward sends WITHOUT
 * `interaction_query`: the signed authorization request outlived its 10
 * minutes (typically a sign-in email opened late). There is nothing to resume,
 * so Trevra starts a fresh authorization; the person usually already has an
 * Authward session by then and lands back in the app without signing in again.
 *
 * The restart is guarded per tab: if one already happened within
 * `INTERACTION_RESTART_WINDOW_MS`, a second expiry shows the message and the
 * normal sign-in options instead of redirecting again, so a request that keeps
 * expiring can never bounce the browser between Trevra and Authward. The
 * marker is a timestamp in sessionStorage: it stops counting after the window
 * and the next restart overwrites it.
 */

export const INTERACTION_RESTART_STORAGE_KEY = 'trevra.authwardInteractionRestartAt';
export const INTERACTION_RESTART_WINDOW_MS = 2 * 60 * 1000;

export const INTERACTION_EXPIRED_MESSAGE = 'Your sign-in link expired. Sign in again to continue.';
export const OAUTH_SESSION_RECOVERY_MESSAGE =
  'We could not restore your sign-in session. Sign in again in this browser.';
export const GOOGLE_NOT_CONFIGURED_MESSAGE =
  'Google sign-in is temporarily unavailable. Try another method.';
export const PROVIDER_UNAVAILABLE_MESSAGE =
  'That sign-in provider is temporarily unavailable. Try another method.';
export const GENERIC_AUTH_ERROR_MESSAGE = "Sign-in couldn't be completed. Please try again.";

export type RestartMarkerStorage = Pick<Storage, 'getItem' | 'setItem'>;

export type AuthErrorOutcome = { kind: 'restart' } | { kind: 'message'; message: string };

export function authErrorMessage(code: string): string {
  if (code === 'google_not_configured') return GOOGLE_NOT_CONFIGURED_MESSAGE;
  if (code === 'interaction_expired') return INTERACTION_EXPIRED_MESSAGE;
  if (code === 'oauth_code_verification_failed') return OAUTH_SESSION_RECOVERY_MESSAGE;
  if (code === 'invalid_client')
    return 'Sign-in is temporarily unavailable. Please try again later.';
  if (code === 'invalid_grant') return 'This sign-in link has expired. Request a new one.';
  // Authward's `<provider>_not_configured` / `<provider>_not_allowed`.
  if (/^[a-z0-9-]+_not_(configured|allowed)$/.test(code)) return PROVIDER_UNAVAILABLE_MESSAGE;
  return GENERIC_AUTH_ERROR_MESSAGE;
}

/**
 * True when this tab may restart sign-in now; records the restart so the next
 * expiry within the window does not. Storage that cannot be read or written
 * gives no loop guard, so it never restarts (the person signs in by hand).
 */
export function claimInteractionRestart(
  storage: RestartMarkerStorage | null,
  now: number = Date.now()
): boolean {
  if (!storage) return false;
  try {
    const last = Number(storage.getItem(INTERACTION_RESTART_STORAGE_KEY));
    // abs(): a marker left by a clock that later moved backwards still counts as recent.
    if (last > 0 && Math.abs(now - last) < INTERACTION_RESTART_WINDOW_MS) return false;
    storage.setItem(INTERACTION_RESTART_STORAGE_KEY, String(now));
    return true;
  } catch {
    return false;
  }
}

export function resolveAuthError(
  code: string,
  storage: RestartMarkerStorage | null,
  now: number = Date.now()
): AuthErrorOutcome {
  if (
    (code === 'interaction_expired' || code === 'oauth_code_verification_failed') &&
    claimInteractionRestart(storage, now)
  ) {
    return { kind: 'restart' };
  }
  return { kind: 'message', message: authErrorMessage(code) };
}

/** `window.sessionStorage`, or null where the browser blocks it (the getter itself can throw). */
export function sessionStorageOrNull(): RestartMarkerStorage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
