/** Public, Trevra-branded messages for login return URLs. Never echo provider codes. */
export function loginAuthError(params: URLSearchParams): string | null {
  if (params.has('auth_error')) {
    const error = params.get('auth_error');
    if (error === 'invite_required') return 'Trevra is invite-only. You can request access below.';
    if (error === 'waitlist') return 'Your Trevra access request is waiting for approval.';
    return error === 'invalid_client'
      ? 'Sign-in is temporarily unavailable. Please try again later.'
      : 'This sign-in link has expired. Request a new one.';
  }
  if (!params.has('error')) return null;
  const code = params.get('error');
  if (
    code === 'invite_required' ||
    (code === 'access_denied' && params.get('error_description') === 'invite_required')
  ) {
    return 'Trevra is invite-only. You can request access below.';
  }
  if (code === 'waitlist') return 'Your Trevra access request is waiting for approval.';
  if (code === 'capacity') return 'Trevra is at capacity. Request access and wait for approval.';
  if (code === 'verification_required') return 'Verify your email before requesting Trevra access.';
  if (code === 'INVALID_TOKEN') {
    return 'That sign-in link is invalid, expired, or has already been used. Request a new one.';
  }
  if (code === 'oauth_code_verification_failed') {
    return 'We could not restore your sign-in session. Sign in again in this browser.';
  }
  if (code === 'invalid_client') {
    return 'Sign-in is temporarily unavailable. Please try again later.';
  }
  return 'We could not complete your sign-in. Please try again.';
}
