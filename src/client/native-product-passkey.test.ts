import { afterEach, describe, expect, it, vi } from 'vitest';
import { nativeTrevraSignIn, registerTrevraPasskey } from './native-product-passkey';

const origin = 'https://app.usetrevra.com';
class Credential {
  static parseRequestOptionsFromJSON = vi.fn((raw) => ({ challenge: raw.challenge }));
  static parseCreationOptionsFromJSON = vi.fn((raw) => ({ challenge: raw.challenge }));
  id = 'synthetic-device-key';
  toJSON() {
    return { id: this.id, type: 'public-key', response: { clientDataJSON: 'synthetic' } };
  }
}
afterEach(() => vi.unstubAllGlobals());
function prepare() {
  vi.stubGlobal('window', { location: { origin }, PublicKeyCredential: Credential });
  vi.stubGlobal('PublicKeyCredential', Credential);
  const get = vi.fn(async () => new Credential());
  const create = vi.fn(async () => new Credential());
  vi.stubGlobal('navigator', { credentials: { get, create } });
  return { get, create };
}
function mockFetch(sequence: Array<object>) {
  const fetch = vi.fn(async (_url: string, _opts?: RequestInit) => ({
    ok: true,
    json: async () => sequence.shift()!
  }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
describe('same-origin Trevra passkey browser flow', () => {
  it('authenticates on the Trevra RP through Authward JSON only, without OAuth navigation', async () => {
    const { get } = prepare();
    const fetch = mockFetch([
      { nonce: 'N'.repeat(48) },
      { challengeId: 'challenge-1', options: { challenge: 'YQ', rpId: 'app.usetrevra.com' } },
      { grant: 'signed-authward-grant' },
      { ok: true }
    ]);
    await nativeTrevraSignIn();
    expect(get).toHaveBeenCalledOnce();
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      '/api/auth/native-passkey/start',
      'https://auth.olaryn.com/v1/product-passkeys/trevra-web/authentication/options',
      'https://auth.olaryn.com/v1/product-passkeys/trevra-web/authentication/verify',
      '/api/auth/native-passkey/complete'
    ]);
    expect(fetch.mock.calls[1][1]).toMatchObject({ credentials: 'omit' });
    expect(fetch.mock.calls[3][1]).toMatchObject({ credentials: 'same-origin' });
  });
  it('enrolls a NEW first-party credential via the authenticated backend only', async () => {
    const { create } = prepare();
    const fetch = mockFetch([
      {
        challengeId: 'challenge-2',
        options: { challenge: 'YQ', user: { id: 'YQ' }, excludeCredentials: [] }
      },
      { ok: true }
    ]);
    await registerTrevraPasskey();
    expect(create).toHaveBeenCalledOnce();
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      '/api/auth/native-passkey/enroll/options',
      '/api/auth/native-passkey/enroll/verify'
    ]);
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toMatchObject({
      challengeId: 'challenge-2',
      response: { id: 'synthetic-device-key' }
    });
  });
  it('rejects another domain before making a network request or invoking WebAuthn', async () => {
    const { get } = prepare();
    vi.stubGlobal('window', { location: { origin: 'https://auth.olaryn.com' } });
    const fetch = mockFetch([]);
    await expect(nativeTrevraSignIn()).rejects.toThrow('app.usetrevra.com');
    expect(fetch).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });
});
