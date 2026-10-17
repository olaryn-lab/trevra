import { describe, expect, it } from 'vitest';
import { migrationAuthority } from './authward-link.js';
const valid = {
  AUTHWARD_ACCOUNT_MIGRATION_ENABLED: 'true',
  TREVRA_DEPLOYMENT_MODE: 'hosted',
  AUTHWARD_ISSUER: 'https://legacy.example.test',
  AUTHWARD_ISOLATED_HOSTED_LOGIN_READY: 'true',
  AUTHWARD_ISOLATED_CLIENT_SECRET: 'x'.repeat(32),
  AUTHWARD_ISOLATED_RESOURCE_SCOPES: 'trevra:access'
};
describe('migration configuration fails closed independently of legacy authority', () => {
  it('defaults off', () => {
    expect(migrationAuthority({})).toBeNull();
  });
  it.each([
    { AUTHWARD_ACCOUNT_MIGRATION_ENABLED: 'yes' },
    { ...valid, AUTHWARD_ISOLATED_CLIENT_SECRET: '' },
    { ...valid, AUTHWARD_ISOLATED_HOSTED_LOGIN_READY: '' },
    { ...valid, AUTHWARD_ISOLATED_RESOURCE_SCOPES: '' },
    { ...valid, TREVRA_DEPLOYMENT_MODE: 'selfhosted' },
    { ...valid, AUTHWARD_ISSUER: 'https://auth.olaryn.com/api/realms/trevra/auth' }
  ])('rejects incomplete or unsafe configuration', (env) => {
    expect(() => migrationAuthority(env)).toThrow();
  });
  it('uses separate isolated credentials without changing the default login flag', () => {
    const env = {
      ...valid,
      AUTHWARD_ISOLATED_ENABLED: 'false',
      AUTHWARD_CLIENT_SECRET: 'legacy-secret'
    };
    expect(migrationAuthority(env)).toMatchObject({
      isolated: true,
      clientId: 'isolated-trevra-web',
      clientSecret: 'x'.repeat(32)
    });
    expect(env.AUTHWARD_ISOLATED_ENABLED).toBe('false');
  });
});
