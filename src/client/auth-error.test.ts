import { describe, expect, it } from 'vitest';
import {
  INTERACTION_EXPIRED_MESSAGE,
  OAUTH_SESSION_RECOVERY_MESSAGE,
  INTERACTION_RESTART_STORAGE_KEY,
  INTERACTION_RESTART_WINDOW_MS,
  resolveAuthError,
  type RestartMarkerStorage
} from './auth-error';

function memoryStorage() {
  const values = new Map<string, string>();
  const storage: RestartMarkerStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value)
  };
  return { storage, values };
}

const t0 = 1_800_000_000_000;

describe('auth_error on the sign-in screen', () => {
  it('restarts sign-in exactly once for interaction_expired', () => {
    const { storage, values } = memoryStorage();
    const outcomes = [
      resolveAuthError('interaction_expired', storage, t0),
      resolveAuthError('interaction_expired', storage, t0 + 1_000),
      resolveAuthError('interaction_expired', storage, t0 + 5_000)
    ];
    expect(outcomes[0]).toEqual({ kind: 'restart' });
    expect(outcomes.filter((outcome) => outcome.kind === 'restart')).toHaveLength(1);
    expect(values.get(INTERACTION_RESTART_STORAGE_KEY)).toBe(String(t0));
  });

  it('shows the expired message instead of redirecting again inside the guard window', () => {
    const { storage, values } = memoryStorage();
    expect(resolveAuthError('interaction_expired', storage, t0)).toEqual({ kind: 'restart' });

    expect(
      resolveAuthError('interaction_expired', storage, t0 + INTERACTION_RESTART_WINDOW_MS - 1)
    ).toEqual({
      kind: 'message',
      message: 'Your sign-in link expired. Sign in again to continue.'
    });
    // A refused restart does not extend the window.
    expect(values.get(INTERACTION_RESTART_STORAGE_KEY)).toBe(String(t0));

    // At the window boundary a new expiry may restart again.
    expect(
      resolveAuthError('interaction_expired', storage, t0 + INTERACTION_RESTART_WINDOW_MS)
    ).toEqual({ kind: 'restart' });
  });

  it('treats a marker from a clock that moved backwards as recent', () => {
    const { storage, values } = memoryStorage();
    values.set(INTERACTION_RESTART_STORAGE_KEY, String(t0 + 30_000));
    expect(resolveAuthError('interaction_expired', storage, t0)).toEqual({
      kind: 'message',
      message: INTERACTION_EXPIRED_MESSAGE
    });
  });

  it('never restarts when sessionStorage is unavailable, so there is no loop guard', () => {
    const throwing: RestartMarkerStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      }
    };
    for (const storage of [null, throwing]) {
      expect(resolveAuthError('interaction_expired', storage, t0)).toEqual({
        kind: 'message',
        message: INTERACTION_EXPIRED_MESSAGE
      });
    }
  });

  it('recovers an emailed OAuth callback opened without the original PKCE cookie once per tab', () => {
    const { storage, values } = memoryStorage();
    expect(resolveAuthError('oauth_code_verification_failed', storage, t0)).toEqual({
      kind: 'restart'
    });
    expect(resolveAuthError('oauth_code_verification_failed', storage, t0 + 1_000)).toEqual({
      kind: 'message',
      message: OAUTH_SESSION_RECOVERY_MESSAGE
    });
    expect(resolveAuthError('interaction_expired', storage, t0 + 2_000)).toEqual({
      kind: 'message',
      message: INTERACTION_EXPIRED_MESSAGE
    });
    expect(values.size).toBe(1);
    // Without reliable session storage a redirect loop must never start.
    expect(resolveAuthError('oauth_code_verification_failed', null, t0)).toEqual({
      kind: 'message',
      message: OAUTH_SESSION_RECOVERY_MESSAGE
    });
    expect(resolveAuthError('invalid_client', memoryStorage().storage, t0).kind).toBe('message');
  });

  it('keeps provider messages and falls back to a generic message for anything else', () => {
    const { storage, values } = memoryStorage();
    const message = (code: string) => resolveAuthError(code, storage, t0);

    expect(message('google_not_configured')).toEqual({
      kind: 'message',
      message: 'Google sign-in is temporarily unavailable. Try another method.'
    });
    expect(message('github_not_allowed')).toEqual({
      kind: 'message',
      message: 'That sign-in provider is temporarily unavailable. Try another method.'
    });
    for (const code of ['state_mismatch', 'EXPIRED_TOKEN', 'session', 'some_future_error']) {
      expect(message(code)).toEqual({
        kind: 'message',
        message: "Sign-in couldn't be completed. Please try again."
      });
    }
    expect(message('invalid_client')).toEqual({
      kind: 'message',
      message: 'Sign-in is temporarily unavailable. Please try again later.'
    });
    expect(message('invalid_grant')).toEqual({
      kind: 'message',
      message: 'This sign-in link has expired. Request a new one.'
    });
    expect(message('<script>alert(1)</script>')).toEqual({
      kind: 'message',
      message: "Sign-in couldn't be completed. Please try again."
    });
    // Only interaction_expired may claim the restart marker.
    expect(values.size).toBe(0);
  });
});
