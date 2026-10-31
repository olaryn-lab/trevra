import { createAuthClient } from 'better-auth/react';
import { magicLinkClient, organizationClient } from 'better-auth/client/plugins';
import { hasCapability, parseWorkspaceRole, type Capability } from '../server/roles';
import type { WorkspaceRole } from './workspace-role';

export { lacksOwnerRole, type WorkspaceRole } from './workspace-role';

/**
 * The `organization` plugin (docs/superpowers/specs/2026-08-13-team-
 * workspace-access-design.md): unlocks `authClient.organization.*` --
 * `list`, `setActive`, `listMembers`, `removeMember`, `listInvitations`,
 * `acceptInvitation`, `cancelInvitation` -- and the reactive hooks built off
 * the same atoms, `useListOrganizations()` and `useActiveOrganization()`
 * (the latter also carries `members`/`invitations` for the workspace the
 * session currently has active -- see `useWorkspaceMembers` in
 * TeamScreen.tsx, the one place this app reads that list).
 *
 * `organization.createInvitation` is NOT called from here: it is a
 * server-only endpoint in better-auth's own plugin (see `crud-invites.mjs`)
 * that needs the inviter's own session on the server, which is why
 * `POST /api/team/members` (src/server/app.ts) exists as a bespoke route.
 */
export const authClient = createAuthClient({
  baseURL: window.location.origin,
  // Better Auth 1.7 treats Generic OAuth as a regular social provider.
  plugins: [magicLinkClient(), organizationClient()]
});

/**
 * The one role signal every role-gated control in the app reads. The server's
 * `parseWorkspaceRole` (src/server/roles.ts) decides owner / manager / member
 * from the Better Auth member row, so the browser and the API agree on it.
 * The server stays the source of truth: this only hides controls.
 */
export function useWorkspaceRole(): WorkspaceRole {
  const { isPending: orgPending } = authClient.useActiveOrganization();
  const { data: activeMember, isPending: memberPending } = authClient.useActiveMember();
  if (orgPending || memberPending) return 'pending';
  return parseWorkspaceRole(activeMember?.role);
}

/**
 * Owner-only controls that have no member line of their own (limits, the
 * export/erase block, who manages the team). False while the role is pending.
 */
export function useIsWorkspaceOwner(): boolean {
  return useWorkspaceRole() === 'owner';
}

/**
 * Whether the signed-in role holds one capability of the central map in
 * src/server/roles.ts. False while the role is pending.
 */
export function useWorkspaceCan(capability: Capability): boolean {
  const role = useWorkspaceRole();
  return role !== 'pending' && hasCapability(role, capability);
}
