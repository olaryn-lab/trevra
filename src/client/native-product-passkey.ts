/** First-party Trevra WebAuthn, with verification performed by Authward as JSON.
 * No Authward webpage is opened; keys belong to app.usetrevra.com only.
 */
const origin = 'https://app.usetrevra.com';
const service = 'https://auth.olaryn.com/v1/product-passkeys/trevra-web/';
function decode(value: string): Uint8Array<ArrayBuffer> {
  const raw = atob(
    value
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '=')
  );
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
function encode(value: ArrayBuffer): string {
  let raw = '';
  for (const byte of new Uint8Array(value)) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function requestOptions(raw: PublicKeyCredentialRequestOptionsJSON): CredentialRequestOptions {
  if (typeof PublicKeyCredential.parseRequestOptionsFromJSON === 'function')
    return { publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(raw) };
  return {
    publicKey: {
      ...raw,
      challenge: decode(raw.challenge),
      allowCredentials: (raw.allowCredentials || []).map((item) => ({
        ...item,
        id: decode(item.id)
      }))
    } as PublicKeyCredentialRequestOptions
  };
}
function createOptions(raw: PublicKeyCredentialCreationOptionsJSON): CredentialCreationOptions {
  if (typeof PublicKeyCredential.parseCreationOptionsFromJSON === 'function')
    return { publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(raw) };
  return {
    publicKey: {
      ...raw,
      challenge: decode(raw.challenge),
      user: { ...raw.user, id: decode(raw.user.id) },
      excludeCredentials: (raw.excludeCredentials || []).map((item) => ({
        ...item,
        id: decode(item.id)
      }))
    } as PublicKeyCredentialCreationOptions
  };
}
function credentialJSON(credential: PublicKeyCredential): object {
  if (typeof credential.toJSON === 'function') return credential.toJSON();
  const res = credential.response;
  const base = {
    id: credential.id,
    type: credential.type,
    rawId: encode(credential.rawId),
    clientExtensionResults: credential.getClientExtensionResults()
  };
  if (res instanceof AuthenticatorAssertionResponse)
    return {
      ...base,
      response: {
        authenticatorData: encode(res.authenticatorData),
        clientDataJSON: encode(res.clientDataJSON),
        signature: encode(res.signature),
        userHandle: res.userHandle ? encode(res.userHandle) : null
      }
    };
  const created = res as AuthenticatorAttestationResponse;
  return {
    ...base,
    response: {
      clientDataJSON: encode(created.clientDataJSON),
      attestationObject: encode(created.attestationObject),
      transports: created.getTransports?.() ?? []
    }
  };
}
async function post(url: string, body: object): Promise<any> {
  const response = await fetch(url, {
    method: 'POST',
    cache: 'no-store',
    credentials: url.startsWith(service) ? 'omit' : 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(typeof data.error === 'string' ? data.error : 'Passkey service unavailable');
  return data;
}
function assertAvailable() {
  if (window.location.origin !== origin)
    throw new Error('Trevra passkeys require app.usetrevra.com');
  if (!window.PublicKeyCredential || !navigator.credentials)
    throw new Error('Passkeys are unavailable in this browser');
}
export async function nativeTrevraSignIn(): Promise<void> {
  assertAvailable();
  const nonce = (await post('/api/auth/native-passkey/start', {})).nonce;
  const prepared = await post(service + 'authentication/options', { nonce });
  const credential = await navigator.credentials.get(requestOptions(prepared.options));
  if (!credential || !(credential instanceof PublicKeyCredential))
    throw new Error('Passkey cancelled');
  const grant = await post(service + 'authentication/verify', {
    challengeId: prepared.challengeId,
    response: credentialJSON(credential)
  });
  const completed = await post('/api/auth/native-passkey/complete', { grant: grant.grant });
  if (completed.ok !== true) throw new Error('Could not establish Trevra session');
}
export async function registerTrevraPasskey(): Promise<void> {
  assertAvailable();
  const prepared = await post('/api/auth/native-passkey/enroll/options', {});
  const credential = await navigator.credentials.create(createOptions(prepared.options));
  if (!credential || !(credential instanceof PublicKeyCredential))
    throw new Error('Passkey enrollment cancelled');
  const verified = await post('/api/auth/native-passkey/enroll/verify', {
    challengeId: prepared.challengeId,
    response: credentialJSON(credential)
  });
  if (verified.ok !== true) throw new Error('Passkey was not saved');
}
