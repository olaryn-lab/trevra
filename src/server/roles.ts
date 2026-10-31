import type { RequestHandler } from 'express';

/**
 * Workspace roles and the ONE capability map every permission check reads
 * (TRV-045).
 *
 * Roles live on Better Auth's `member.role` (organization plugin). Trevra adds
 * `manager` beside the plugin's `owner` and `member`; `auth-service.ts` wires
 * the matching Better Auth access-control role, derived from this map, so the
 * plugin's own `/organization/*` routes and Trevra's routes cannot disagree.
 *
 * DETERMINISTIC, AND IN ONE PLACE. A route asks `requireCapability(cap)` (or
 * `hasCapability(role, cap)` inside a handler) -- never `role === 'owner'`.
 * Adding a capability or moving a role into or out of one is an edit to this
 * table and nothing else. The client imports the same table to hide controls a
 * role cannot use; the server's 403 stays the boundary.
 *
 * This module is pure (types-only imports) so the browser bundle can import it.
 */

export const WORKSPACE_ROLES = ['owner', 'manager', 'member'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

const EVERYONE = ['owner', 'manager', 'member'] as const;
const OWNER_OR_MANAGER = ['owner', 'manager'] as const;
const OWNER = ['owner'] as const;

export const CAPABILITIES = {
  /* --- Every role (open before TRV-045; declared so the gate is explicit). --- */
  /** Team/rep reports, daily and team CSVs, campaign export CSV. */
  'reports.view': EVERYONE,
  /** Inbox tags, notes, assignment, reply classification and bulk organize. */
  'inbox.organize': EVERYONE,
  /** Prepare a CRM contact upsert; the write itself waits for approval. */
  'crm.prepare': EVERYONE,
  /** Decide a waiting playbook approval step (outreach sends, CRM, Buffer). */
  'playbooks.decide': EVERYONE,
  /** Mint an agent token for one's own MCP/CLI client. */
  'agent_tokens.create': EVERYONE,

  /* --- Owner and manager. --- */
  /** Approve or reject outreach content: LinkedIn actions, campaign emails, AI drafts, withdrawals, scheduled posts, Reddit comments. */
  'outreach.approve': OWNER_OR_MANAGER,
  /** Manage every campaign regardless of its owner, on any seat; delete and transfer campaigns. */
  'campaigns.manage_all': OWNER_OR_MANAGER,
  /** Workspace workflow templates and any teammate's personal workflow. */
  'workflows.manage_workspace': OWNER_OR_MANAGER,
  /** Assign which teammate a LinkedIn seat belongs to (assignment only, not its limits). */
  'seats.assign': OWNER_OR_MANAGER,
  /** Rename or delete lead lists and delete lead contacts. */
  'lead_lists.manage': OWNER_OR_MANAGER,
  /** Download a rendered ledger export. */
  'exports.download': OWNER_OR_MANAGER,
  /** Invite a teammate with the `member` role. */
  'team.invite': OWNER_OR_MANAGER,
  /** Remove a teammate whose role is `member`. */
  'team.remove': OWNER_OR_MANAGER,

  /* --- Owner only. --- */
  /** Change any role; invite, remove or cancel invitations for owners and managers. */
  'team.roles': OWNER,
  'billing.manage': OWNER,
  /** Workspace policy rules (allow / deny / require_approval). */
  'policy.manage': OWNER,
  /** Provider credentials and custody: LinkedIn/Reddit sign-in, hosted execution, companion pairing, BYOK model key, CLI token, Hunter key. */
  'credentials.manage': OWNER,
  /** Provider connections: webhooks, capture sources, GitHub, mailbox, DKIM, citation source, booking link. */
  'integrations.manage': OWNER,
  /** Hosted agent setup: model endpoint, CLI agent, risk acceptance, budget, schedule. */
  'agent.configure': OWNER,
  /** Agent principals carry scopes and skills, so any change is a scope change. */
  'agents.manage': OWNER,
  /** Revoke public API (agent) tokens. */
  'api_tokens.manage': OWNER,
  'outbound_webhooks.manage': OWNER,
  /** Account-risk ceilings: seat limits/hours/band, InMail caps, mailbox limits, resume, disconnect, daily lead ceiling. */
  'account_safety.manage': OWNER,
  /** Paid contact enrichment and its credit cap. */
  'enrichment.spend': OWNER,
  /** Community module publishing and installation. */
  'registry.manage': OWNER,
  /** Sender identity, person/account country, lawful bases. */
  'compliance.manage': OWNER,
  /** Settle whether an uncertain community write happened. */
  'community.resolve': OWNER,
  'workspace.export': OWNER,
  'workspace.erase': OWNER
} as const satisfies Record<string, readonly WorkspaceRole[]>;

export type Capability = keyof typeof CAPABILITIES;

/**
 * Better Auth's `member.role` to a Trevra role. The plugin comma-joins
 * multi-role members (`parseRoles`), so this parses the same way; the highest
 * role wins. Anything unknown (including the plugin's unused `admin`) is the
 * least-privileged `member` -- fail closed.
 */
export function parseWorkspaceRole(raw: string | null | undefined): WorkspaceRole {
  const parts = String(raw ?? '')
    .split(',')
    .map((part) => part.trim());
  if (parts.includes('owner')) return 'owner';
  if (parts.includes('manager')) return 'manager';
  return 'member';
}

export function hasCapability(
  role: WorkspaceRole | null | undefined,
  capability: Capability
): boolean {
  if (!role) return false;
  return (CAPABILITIES[capability] as readonly WorkspaceRole[]).includes(role);
}

/** Every capability a role holds, for display and for the Better Auth role derivation. */
export function capabilitiesOf(role: WorkspaceRole): Capability[] {
  return (Object.keys(CAPABILITIES) as Capability[]).filter((cap) => hasCapability(role, cap));
}

/** The refusal sentence, worded by who CAN do it. */
export function capabilityRefusal(capability: Capability, act: string): string {
  const allowed = CAPABILITIES[capability] as readonly WorkspaceRole[];
  if (allowed.length === 1) return `Only the workspace owner can ${act}`;
  if (!allowed.includes('member')) return `Only a workspace owner or manager can ${act}`;
  return `Your workspace role cannot ${act}`;
}

/**
 * May `actor` invite, remove or cancel an invitation for someone holding (or
 * being offered) `target`? A `member` target needs `team.invite`/`team.remove`;
 * an owner or manager target needs `team.roles`.
 */
export function canManageTeammate(
  actor: WorkspaceRole,
  target: WorkspaceRole,
  act: 'invite' | 'remove'
): boolean {
  if (target !== 'member') return hasCapability(actor, 'team.roles');
  return hasCapability(actor, act === 'invite' ? 'team.invite' : 'team.remove');
}

/** Express guard: 403 unless the session's role holds `capability`. */
export function requireCapability(capability: Capability, act: string): RequestHandler {
  return (req, res, next) => {
    const role = (req as { auth?: { role?: WorkspaceRole } }).auth?.role;
    if (!hasCapability(role, capability)) {
      res.status(403).json({ error: capabilityRefusal(capability, act) });
      return;
    }
    next();
  };
}
