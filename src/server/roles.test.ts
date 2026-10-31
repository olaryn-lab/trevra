import { describe, expect, it, vi } from 'vitest';
import {
  CAPABILITIES,
  WORKSPACE_ROLES,
  canManageTeammate,
  capabilitiesOf,
  capabilityRefusal,
  hasCapability,
  parseWorkspaceRole,
  requireCapability,
  type Capability
} from './roles.js';

const MANAGER_FORBIDDEN: Capability[] = [
  'team.roles',
  'billing.manage',
  'policy.manage',
  'credentials.manage',
  'integrations.manage',
  'agent.configure',
  'agents.manage',
  'api_tokens.manage',
  'outbound_webhooks.manage',
  'account_safety.manage',
  'enrichment.spend',
  'registry.manage',
  'compliance.manage',
  'community.resolve',
  'workspace.export',
  'workspace.erase'
];

const MANAGER_ONLY_OVER_MEMBER: Capability[] = [
  'outreach.approve',
  'campaigns.manage_all',
  'workflows.manage_workspace',
  'seats.assign',
  'lead_lists.manage',
  'exports.download',
  'team.invite',
  'team.remove'
];

describe('workspace capability map', () => {
  it('gives the owner every capability, so owner behaviour is unchanged', () => {
    expect(capabilitiesOf('owner').sort()).toEqual(Object.keys(CAPABILITIES).sort());
  });

  it('keeps money, permissions, credentials and scope changes away from a manager', () => {
    for (const capability of MANAGER_FORBIDDEN)
      expect([capability, hasCapability('manager', capability)]).toEqual([capability, false]);
    const managerCaps = new Set(capabilitiesOf('manager'));
    const expected = (Object.keys(CAPABILITIES) as Capability[]).filter(
      (capability) => !MANAGER_FORBIDDEN.includes(capability)
    );
    expect([...managerCaps].sort()).toEqual(expected.sort());
  });

  it('gives a manager outreach approval and team operations a member lacks', () => {
    for (const capability of MANAGER_ONLY_OVER_MEMBER) {
      expect([capability, hasCapability('manager', capability)]).toEqual([capability, true]);
      expect([capability, hasCapability('member', capability)]).toEqual([capability, false]);
    }
  });

  it('never gives a member something a manager lacks', () => {
    for (const capability of capabilitiesOf('member'))
      expect([capability, hasCapability('manager', capability)]).toEqual([capability, true]);
  });

  it('fails closed for a missing role', () => {
    expect(hasCapability(null, 'reports.view')).toBe(false);
    expect(hasCapability(undefined, 'reports.view')).toBe(false);
  });
});

describe('parseWorkspaceRole', () => {
  it.each([
    ['owner', 'owner'],
    ['manager', 'manager'],
    ['member', 'member'],
    ['member,manager', 'manager'],
    ['manager, owner', 'owner'],
    ['admin', 'member'],
    ['', 'member'],
    [null, 'member'],
    [undefined, 'member']
  ] as const)('%s -> %s', (raw, role) => {
    expect(parseWorkspaceRole(raw)).toBe(role);
  });

  it('covers exactly the three Trevra roles', () => {
    expect([...WORKSPACE_ROLES]).toEqual(['owner', 'manager', 'member']);
  });
});

describe('canManageTeammate', () => {
  it('lets an owner manage anyone, a manager only members, a member nobody', () => {
    for (const act of ['invite', 'remove'] as const) {
      expect(WORKSPACE_ROLES.map((target) => canManageTeammate('owner', target, act))).toEqual([
        true,
        true,
        true
      ]);
      expect(WORKSPACE_ROLES.map((target) => canManageTeammate('manager', target, act))).toEqual([
        false,
        false,
        true
      ]);
      expect(WORKSPACE_ROLES.map((target) => canManageTeammate('member', target, act))).toEqual([
        false,
        false,
        false
      ]);
    }
  });
});

describe('requireCapability', () => {
  function run(role: string | undefined, capability: Capability) {
    const res = { status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);
    const next = vi.fn();
    requireCapability(capability, 'do the thing')(
      { auth: role ? { role } : undefined } as never,
      res as never,
      next
    );
    return { res, next };
  }

  it('passes a role that holds the capability', () => {
    const { res, next } = run('manager', 'outreach.approve');
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('answers 403 with a sentence naming who can', () => {
    const owner = run('manager', 'billing.manage');
    expect(owner.next).not.toHaveBeenCalled();
    expect(owner.res.status).toHaveBeenCalledWith(403);
    expect(owner.res.json).toHaveBeenCalledWith({
      error: 'Only the workspace owner can do the thing'
    });
    const managers = run('member', 'outreach.approve');
    expect(managers.res.json).toHaveBeenCalledWith({
      error: 'Only a workspace owner or manager can do the thing'
    });
    expect(run(undefined, 'reports.view').res.status).toHaveBeenCalledWith(403);
  });

  it('words a refusal for a capability every role holds generically', () => {
    expect(capabilityRefusal('reports.view', 'look')).toBe('Your workspace role cannot look');
  });
});
