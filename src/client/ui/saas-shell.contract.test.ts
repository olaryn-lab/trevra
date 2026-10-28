import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const campaignList = readFileSync(new URL('../LinkedInManagerRead.tsx', import.meta.url), 'utf8');
const campaignBuilder = readFileSync(
  new URL('../LinkedInManagerBuilder.tsx', import.meta.url),
  'utf8'
);
const actionApprovals = readFileSync(
  new URL('../LinkedInActionApprovals.tsx', import.meta.url),
  'utf8'
);
const withdrawalApprovals = readFileSync(
  new URL('../LinkedInWithdrawalApprovals.tsx', import.meta.url),
  'utf8'
);
const passkeySettings = readFileSync(
  new URL('../NativeTrevraPasskeySettings.tsx', import.meta.url),
  'utf8'
);

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

  it('keeps workspace setup task-focused with discoverable secondary settings', () => {
    expect(source).toContain('Connect your workspace');
    expect(source).toContain('Connections &amp; sending');
    expect(source).toContain('Account &amp; team');
    expect(source).toContain('Safety &amp; advanced settings');
    expect(source).toMatch(/<details className="workspace-settings-group">/);
    expect(source).toContain('<ConnectionsView');
    expect(source).toContain('<LinkedInExclusions');
    expect(source).toContain('<TeamSettingsView');
    expect(css).toContain('.workspace-settings-group > summary:focus-visible');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('shows one campaign creation action in an empty workspace and keeps rare actions in a menu', () => {
    expect(campaignList).toContain('{campaigns.length > 0 && (');
    expect(campaignList).toContain('Build your first campaign');
    expect(campaignList).toContain("label: 'Retry safe failures'");
    expect(campaignList).toContain('Replace custom steps with v${workflow!.version}');
    expect(campaignBuilder).toContain('<Field label="Campaign name">');
    expect(campaignBuilder).toContain('<Button variant="primary" disabled={busy || !ready}');
  });

  it('makes approval decisions readable with the same panel and button components', () => {
    for (const approvals of [actionApprovals, withdrawalApprovals]) {
      expect(approvals).toContain('<Panel');
      expect(approvals).toContain('<Button');
      expect(approvals).toContain('className="li-review-item"');
      expect(approvals).toContain('className="li-review-footer"');
      expect(approvals).toContain('role="alert"');
    }
    expect(actionApprovals).toContain('className="li-review-message"');
    expect(actionApprovals).not.toContain("style={{ whiteSpace: 'pre-wrap'");
    expect(css).toContain('.li-review-message');
  });

  it('shares passkey control styling and describes outcomes accessibly', () => {
    expect(passkeySettings).toContain('<Panel');
    expect(passkeySettings).toContain('<Button');
    expect(passkeySettings).not.toContain('style={{ padding: 20 }}');
    expect(passkeySettings).toContain("role={message.error ? 'alert' : 'status'}");
    expect(source).toContain("if (route.sub === 'billing') return 'Setup · Billing';");
    expect(source).not.toContain('Open source and self-hostable');
  });

  it('retains visible mobile tabs and compact safe-area content margins', () => {
    expect(css).toMatch(
      /@media \(max-width: 760px\)\s*\{[\s\S]*?\.main\s*\{\s*padding:\s*0 16px calc/
    );
    expect(source).toContain('className="mobile-tabbar"');
    expect(css).toMatch(/\.topbar\s*\{[^}]*border-bottom:\s*1px solid var\(--t-line\)/);
  });
});
