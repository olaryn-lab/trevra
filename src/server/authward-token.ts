import { validateAuthorizationCode } from 'better-auth/oauth2';

/** OAuth protocol errors are identified by their JSON error field, not HTTP status. */
export function authwardTokenErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('error' in error)) return null;
  return typeof error.error === 'string' ? error.error : null;
}

/** Use Better Auth's OAuth exchange with Trevra-specific, sanitized error handling. */
export async function exchangeAuthwardCode(
  issuer: string,
  clientId: string,
  clientSecret: string,
  data: { code: string; codeVerifier?: string; redirectURI: string },
  registeredRedirectURI: string
) {
  const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
    headers: { accept: 'application/json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) throw new Error('Trevra sign-in discovery failed');
  const metadata = (await response.json()) as { token_endpoint?: unknown };
  if (typeof metadata.token_endpoint !== 'string') {
    throw new Error('Trevra sign-in token endpoint is unavailable');
  }
  const tokenEndpoint = new URL(metadata.token_endpoint);
  if (tokenEndpoint.origin !== new URL(issuer).origin) {
    throw new Error('Trevra sign-in token endpoint has an unexpected origin');
  }

  try {
    return await validateAuthorizationCode({
      code: data.code,
      codeVerifier: data.codeVerifier,
      // Better Auth 1.7 passes its INTERNAL /callback/authward route here.
      // Authward bound the code to our explicitly registered, legacy
      // /oauth2/callback/authward URI during authorization. Token exchange
      // MUST use that same original URI or Authward returns invalid_grant.
      redirectURI: registeredRedirectURI,
      options: { clientId, clientSecret, redirectURI: registeredRedirectURI },
      tokenEndpoint: tokenEndpoint.toString(),
      authentication: 'basic',
      additionalParams: { resource: 'https://api.usetrevra.com' }
    });
  } catch (error) {
    switch (authwardTokenErrorCode(error)) {
      case 'invalid_client':
        console.error('Trevra sign-in client authentication failed (invalid_client)');
        throw new Error('Trevra sign-in client configuration failure');
      case 'invalid_grant':
        throw new Error('Trevra sign-in authorization code rejected');
      default:
        throw new Error('Trevra sign-in token exchange failed');
    }
  }
}
