import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

describe('contextual feedback rules', () => {
  it('shows ownership restrictions only when settings are locked', () => {
    const source = read('./LinkedInManagerCampaignConfig.tsx');
    expect(source).toContain('!isWorkspaceOwner && (');
    expect(source).toContain('Only the workspace owner can change mailbox limits.');
    expect(source).not.toContain('You can edit it here.');
  });
  it('keeps linkedIn worker blockers without long generic capability commentary', () => {
    const source = read('./LinkedInCompanion.tsx');
    expect(source).toContain('{blockers.map((blocker) => (');
    expect(source).toContain('if (!worker || worker.ready) return null;');
    expect(source).not.toContain('You can still add accounts here');
  });
  it('places one-time-token warning next to creation, not as page status', () => {
    const source = read('./App.tsx');
    expect(source).toContain('New access tokens are shown only once.');
    expect(source).not.toContain('This workspace already has {active.length} active');
  });
});
