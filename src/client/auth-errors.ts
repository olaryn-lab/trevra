/** Public, Trevra-branded messages for login return URLs. Never echo provider codes. */
export function loginAuthError(params: URLSearchParams): string | null {
  if (params.has('auth_error')) {
    return params.get('auth_error') === 'invalid_client'
      ? 'Sign-in is temporarily unavailable. Please try again later.'
      : 'This sign-in link has expired. Request a new one.';
  }
  if (!params.has('error')) return null;
  const code = params.get('error');
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
