import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8');
const login = readFileSync(
  fileURLToPath(new URL('./login-contract-v2.css', import.meta.url)),
  'utf8'
);

describe('fleet radius contract', () => {
  it('uses six-pixel controls and twelve-pixel panels', () => {
    expect(css).toMatch(/--t-r-sm: 6px;/);
    expect(css).toMatch(/--t-r-md: 6px;/);
    expect(css).toMatch(/--t-r-lg: 12px;/);
    expect(css).toMatch(
      /\.ui-control:not\(\[type='checkbox'\]\):not\(\[type='radio'\]\)[^{]*\{[^}]*border-radius: var\(--t-r-md\)/
    );
    expect(css).toMatch(/\.ui-panel \{[^}]*border-radius: var\(--t-r-lg\)/);
  });
  it('keeps circular switch geometry and normalizes login buttons', () => {
    expect(css).toMatch(/\.toggle span \{[^}]*border-radius: var\(--t-r-pill\)/);
    expect(login).toMatch(/\.ol-auth-card \{[^}]*border-radius:12px!important/);
    expect(login).toMatch(/border-radius:6px!important/);
  });
});
