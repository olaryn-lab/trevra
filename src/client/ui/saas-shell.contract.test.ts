import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

describe('Trevra compact work console, Olaryn-compatible without stale styling', () => {
  it('limits sidebar width, gives content a zero-minimum track, and shortens navigation', () => {
    expect(css).toMatch(/\.app-shell\s*\{[^}]*grid-template-columns:\s*228px minmax\(0, 1fr\)/);
    expect(css).toMatch(/\.sidebar\s*\{[^}]*padding:\s*16px 12px/);
    expect(css).toMatch(/\.sidebar nav\s*\{[^}]*gap:\s*2px/);
    expect(css).toMatch(/\.topbar\s*\{[^}]*min-height:\s*64px/);
    expect(source).toContain('className="app-shell ui-standard"');
  });

  it('preserves the newer 6px control, 12px panel and keyboard focus contract', () => {
    expect(css).toContain('--t-r-sm: 6px');
    expect(css).toContain('--t-r-lg: 12px');
    expect(css).toMatch(/\.ui-standard :is\(\.primary-button[^}]*border-radius:\s*var\(--t-r-md\)/);
    expect(css).not.toMatch(
      /\.ui-standard :is\(\.primary-button[^}]*border-radius:\s*var\(--t-r-pill\)/
    );
    expect(css).toMatch(/\.ui-panel\s*\{[^}]*border-radius:\s*var\(--t-r-lg\)/);
    expect(css).toContain(':focus-visible');
  });

  it('retains visible mobile tabs and compact safe-area content margins', () => {
    expect(css).toMatch(
      /@media \(max-width: 760px\)\s*\{[\s\S]*?\.main\s*\{\s*padding:\s*0 16px calc/
    );
    expect(source).toContain('className="mobile-tabbar"');
    expect(css).toMatch(/\.topbar\s*\{[^}]*border-bottom:\s*1px solid var\(--t-line\)/);
  });
});
