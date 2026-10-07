/**
 * The origin a recipient's mail client can reach. Campaign tracking pixels and
 * click redirects (linkedin/campaign-channels.ts) and RFC 8058 unsubscribe links
 * (email/unsubscribe.ts) all point here. Production requires HTTPS on a
 * non-loopback host. Null means no recipient-reachable origin is configured.
 */
export function publicEmailOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw =
    env.TREVRA_PUBLIC_API_URL ??
    env.BETTER_AUTH_URL ??
    env.APP_ORIGIN?.split(',')[0]?.trim() ??
    env.PUBLIC_SITE_URL ??
    '';
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (
      env.NODE_ENV === 'production' &&
      (url.protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}
