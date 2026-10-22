import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = readFileSync(fileURLToPath(new URL('./App.tsx', import.meta.url)), 'utf8');

describe('hosted Trevra login action hierarchy', () => {
  it('never promotes both passkey and the first social provider to primary', () => {
    expect(src).toContain('className="google-auth-button ol-auth-action ol-auth-primary"');
    expect(src).toContain("(index === 0 && !passkeyEnabled ? 'ol-auth-primary' : '')");
  });
  it('calls native Trevra passkey rather than the legacy redirected OAuth method', () => {
    expect(src).toContain('await nativeTrevraSignIn()');
    expect(src).not.toContain("startAuthwardSignIn(undefined, 'passkey')");
  });
});
