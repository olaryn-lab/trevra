import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { verifyLinkIdentity } from './authward-link.js';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const issuer = 'https://isolated.test';
const now = Math.floor(Date.now() / 1000);
const as = { issuer, jwks_uri: issuer + '/jwks', id_token_signing_alg_values_supported: ['EdDSA'] };
const client = { client_id: 'isolated-test', id_token_signed_response_alg: 'EdDSA' };
function response(overrides: Record<string, unknown> = {}, invalidSignature = false) {
  const content = [
    { alg: 'EdDSA', kid: 'key' },
    {
      iss: issuer,
      aud: client.client_id,
      sub: 'new-subject',
      iat: now,
      exp: now + 300,
      auth_time: now,
      nonce: 'fresh-nonce',
      ...overrides
    }
  ]
    .map((x) => Buffer.from(JSON.stringify(x)).toString('base64url'))
    .join('.');
  const signature = invalidSignature
    ? Buffer.alloc(64)
    : sign(null, Buffer.from(content), privateKey);
  return Response.json({
    access_token: 'unused',
    token_type: 'Bearer',
    id_token: content + '.' + signature.toString('base64url')
  });
}
function verify(overrides: Record<string, unknown> = {}, invalidSignature = false) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'key', alg: 'EdDSA', use: 'sig' }]
      })
    )
  );
  return verifyLinkIdentity(
    as,
    client,
    response(overrides, invalidSignature),
    'fresh-nonce',
    new Date(now * 1000)
  );
}
afterEach(() => vi.unstubAllGlobals());
describe('migration JWT validation using real Ed25519 signatures', () => {
  it('accepts fresh signed issuer-qualified identity independent of email', async () => {
    expect(await verify({ email: 'different@example.test' })).toMatchObject({
      sub: 'new-subject',
      iss: issuer
    });
  });
  it.each([
    { iss: 'https://other.test' },
    { aud: 'other-client' },
    { nonce: 'attacker-nonce' },
    { exp: now - 600 },
    { auth_time: now - 60 },
    { sub: '' },
    { auth_time: undefined },
    { aud: [client.client_id, 'other'], azp: 'other' }
  ])('rejects invalid claims %j', async (overrides) => {
    await expect(verify(overrides)).rejects.toThrow();
  });
  it('rejects a forged signature', async () => {
    await expect(verify({}, true)).rejects.toThrow();
  });
  it('requires an ID token', async () => {
    await expect(
      verifyLinkIdentity(
        as,
        client,
        Response.json({ access_token: 'unused', token_type: 'Bearer' }),
        'fresh-nonce',
        new Date()
      )
    ).rejects.toThrow();
  });
});
