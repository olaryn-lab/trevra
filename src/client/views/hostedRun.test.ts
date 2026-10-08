import { describe, expect, it } from 'vitest';
import { hostedRunBlocker, type HostedRunBlockerInput } from './hostedRun';

const ready: HostedRunBlockerInput = {
  role: 'owner',
  dirtyCap: false,
  modelAccessDirty: false,
  modelAccessMissing: false,
  spendingEnabled: true,
  capReached: false,
  monthlyCapCents: 2000,
  agentId: 'agt_1',
  goal: 'Follow up'
};

describe('hostedRunBlocker', () => {
  it('lets a ready workspace run', () => {
    expect(hostedRunBlocker(ready)).toBeNull();
    expect(hostedRunBlocker({ ...ready, role: 'member' })).toBeNull();
  });

  it('tells an owner, and a pending role, to do the fix themselves', () => {
    for (const role of ['owner', 'pending'] as const) {
      const base = { ...ready, role };
      expect(hostedRunBlocker({ ...base, modelAccessMissing: true })).toBe(
        'Configure model access before starting a hosted run.'
      );
      expect(hostedRunBlocker({ ...base, spendingEnabled: false })).toBe(
        'Turn on model spending before starting a hosted run.'
      );
      expect(hostedRunBlocker({ ...base, capReached: true })).toContain('Raise the limit');
    }
  });

  it('tells a member to ask the workspace owner', () => {
    const base = { ...ready, role: 'member' as const };
    expect(hostedRunBlocker({ ...base, modelAccessMissing: true })).toContain(
      'The workspace owner has to configure model access'
    );
    expect(hostedRunBlocker({ ...base, spendingEnabled: false })).toContain(
      'The workspace owner has to turn on model spending'
    );
    expect(hostedRunBlocker({ ...base, capReached: true })).toContain(
      'The workspace owner can raise the limit.'
    );
  });

  it('keeps the owner-independent blockers', () => {
    expect(hostedRunBlocker({ ...ready, agentId: '' })).toBe('Choose an active Agent first.');
    expect(hostedRunBlocker({ ...ready, goal: '  ' })).toBe(
      'Write the job you want this Agent to do.'
    );
  });
});
