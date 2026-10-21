/** Server-only Authward authority selection. Legacy credentials are never repurposed. */
export function authwardAuthority(env: NodeJS.ProcessEnv = process.env) {
  const flag = env.AUTHWARD_ISOLATED_ENABLED ?? 'false';
  if (!['true', 'false'].includes(flag))
    throw new Error('AUTHWARD_ISOLATED_ENABLED must be true or false');
  const isolated = flag === 'true';
  if (!isolated) {
    if (
      env.AUTHWARD_ISSUER?.replace(/\/$/, '') === 'https://auth.olaryn.com/api/realms/trevra/auth'
    )
      throw new Error(
        'Realm authority requires AUTHWARD_ISOLATED_ENABLED=true and separate credentials'
      );
    return {
      isolated,
      issuer: env.AUTHWARD_ISSUER?.trim().replace(/\/$/, ''),
      clientId: env.AUTHWARD_CLIENT_ID?.trim(),
      clientSecret: env.AUTHWARD_CLIENT_SECRET?.trim(),
      scopes: ['openid', 'profile', 'email', 'offline_access', 'trevra:access']
    };
  }
  if (env.TREVRA_DEPLOYMENT_MODE !== 'hosted')
    throw new Error('Isolated Authward requires hosted mode');
  if (env.AUTHWARD_ISOLATED_HOSTED_LOGIN_READY !== 'true')
    throw new Error(
      'Isolated Authward setup missing: verify hosted passkey, social and magic-link login before setting AUTHWARD_ISOLATED_HOSTED_LOGIN_READY=true'
    );
  const clientSecret = env.AUTHWARD_ISOLATED_CLIENT_SECRET?.trim();
  if (!clientSecret || clientSecret.length < 32)
    throw new Error('AUTHWARD_ISOLATED_CLIENT_SECRET must contain at least 32 characters');
  const resourceScopes = env.AUTHWARD_ISOLATED_RESOURCE_SCOPES?.trim().split(/\s+/).filter(Boolean);
  if (
    !resourceScopes?.length ||
    resourceScopes.some((scope) => !/^trevra:[a-zA-Z0-9:_-]+$/.test(scope))
  )
    throw new Error(
      'AUTHWARD_ISOLATED_RESOURCE_SCOPES must list the registered trevra resource scopes; do not guess grants'
    );
  return {
    isolated,
    issuer: 'https://auth.olaryn.com/api/realms/trevra/auth',
    clientId: 'isolated-trevra-web',
    clientSecret,
    scopes: ['openid', 'profile', 'email', 'offline_access', ...resourceScopes]
  };
}

export function isolatedSubject(issuer: string, profile: Record<string, unknown>): string {
  if (typeof profile.sub !== 'string' || !profile.sub.trim())
    throw new Error('OIDC subject is required');
  return JSON.stringify([issuer, profile.sub]);
}
