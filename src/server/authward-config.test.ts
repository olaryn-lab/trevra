import { describe, expect, it } from 'vitest';
import { authwardAuthority, isolatedSubject } from './authward-config.js';

const legacy = {
  AUTHWARD_ISSUER: 'https://auth.olaryn.com',
  AUTHWARD_CLIENT_ID: 'trevra-web',
  AUTHWARD_CLIENT_SECRET: 'legacy'
};
const isolated = {
  ...legacy,
  TREVRA_DEPLOYMENT_MODE: 'hosted',
  AUTHWARD_ISOLATED_ENABLED: 'true',
  AUTHWARD_ISOLATED_HOSTED_LOGIN_READY: 'true',
  AUTHWARD_ISOLATED_CLIENT_SECRET: 'x'.repeat(32),
  AUTHWARD_ISOLATED_RESOURCE_SCOPES: 'trevra:access trevra:read'
};
describe('Authward authority isolation', () => {
  it('preserves legacy settings by default even with staged isolated credentials', () => {
    expect(authwardAuthority({ ...isolated, AUTHWARD_ISOLATED_ENABLED: 'false' })).toMatchObject({
      isolated: false,
      issuer: legacy.AUTHWARD_ISSUER,
      clientId: 'trevra-web',
      clientSecret: 'legacy'
    });
  });
  it('selects separate confidential credentials and issuer-relative discovery', () => {
    const config = authwardAuthority(isolated);
    expect(config.issuer + '/.well-known/openid-configuration').toBe(
      'https://auth.olaryn.com/api/realms/trevra/auth/.well-known/openid-configuration'
    );
    expect(config.clientId).toBe('isolated-trevra-web');
    expect(config.clientSecret).not.toBe(legacy.AUTHWARD_CLIENT_SECRET);
    expect(config.scopes).toContain('trevra:read');
  });
  it('fails closed for incomplete setup and accidental legacy realm switching', () => {
    expect(() =>
      authwardAuthority({ ...isolated, AUTHWARD_ISOLATED_HOSTED_LOGIN_READY: undefined })
    ).toThrow(/setup missing/);
    expect(() =>
      authwardAuthority({ ...isolated, AUTHWARD_ISOLATED_CLIENT_SECRET: undefined })
    ).toThrow(/CLIENT_SECRET/);
    expect(() =>
      authwardAuthority({ ...isolated, AUTHWARD_ISOLATED_RESOURCE_SCOPES: undefined })
    ).toThrow(/RESOURCE_SCOPES/);
    expect(() => authwardAuthority({ ...legacy, AUTHWARD_ISSUER: isolatedIssuer })).toThrow(
      /separate credentials/
    );
  });
  it('keys isolated identities by issuer and exact subject, never email or profile id', () => {
    expect(
      isolatedSubject(isolatedIssuer, { sub: 'A', id: 'other', email: 'same@example.com' })
    ).toBe(JSON.stringify([isolatedIssuer, 'A']));
    expect(isolatedSubject(isolatedIssuer, { sub: 'A' })).not.toBe(
      isolatedSubject(legacy.AUTHWARD_ISSUER, { sub: 'A' })
    );
    expect(() => isolatedSubject(isolatedIssuer, { id: 'A', email: 'same@example.com' })).toThrow(
      /subject/
    );
  });
});
const isolatedIssuer = 'https://auth.olaryn.com/api/realms/trevra/auth';
