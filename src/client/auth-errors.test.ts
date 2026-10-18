import { describe, expect, it } from 'vitest';
import { loginAuthError } from './auth-errors';

describe('Trevra login callback errors', () => {
  it.each(['expired', 'google_not_configured', '<script>alert(1)</script>', ''])(
    'shows friendly branded copy for auth_error=%s',
    (code) => {
      const message = loginAuthError(new URLSearchParams({ auth_error: code }));
      expect(message).toBe('This sign-in link has expired. Request a new one.');
      expect(message).not.toContain('Olaryn');
    }
  );

  it('treats invalid_client as a temporary sign-in outage, not an expired grant', () => {
    expect(loginAuthError(new URLSearchParams('auth_error=invalid_client'))).toBe(
      'Sign-in is temporarily unavailable. Please try again later.'
    );
  });

  it('handles Better Auth callback failures and old magic-link errors without raw codes', () => {
    expect(loginAuthError(new URLSearchParams('error=oauth_code_verification_failed'))).toMatch(
      /temporarily unavailable/
    );
    expect(loginAuthError(new URLSearchParams('error=INVALID_TOKEN'))).toMatch(/Request a new one/);
    expect(loginAuthError(new URLSearchParams('error=state_mismatch'))).toBe(
      'We could not complete your sign-in. Please try again.'
    );
    expect(loginAuthError(new URLSearchParams())).toBeNull();
  });
});
