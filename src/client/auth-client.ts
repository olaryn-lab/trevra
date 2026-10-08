import { createAuthClient } from 'better-auth/react';
import {
  genericOAuthClient,
  magicLinkClient,
  organizationClient
} from 'better-auth/client/plugins';

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
  plugins: [genericOAuthClient(), magicLinkClient(), organizationClient()]
});

/**
 * `pending` until BOTH the organization and the member read have resolved, so
 * a panel can hold back the owner controls AND the member's read-only line:
 * an owner on a hard reload must not see "Only the workspace owner can ..."
 * flash on, and a member must not see an owner control flash on.
 */
export type WorkspaceRole = 'pending' | 'owner' | 'member';

/**
 * The one role signal every owner-only control in the app reads.
 * `activeMember?.role === 'owner'` is the one place that decides who is an
 * owner once the reads have resolved; everyone else is a member.
 */
export function useWorkspaceRole(): WorkspaceRole {
  const { isPending: orgPending } = authClient.useActiveOrganization();
  const { data: activeMember, isPending: memberPending } = authClient.useActiveMember();
  if (orgPending || memberPending) return 'pending';
  return activeMember?.role === 'owner' ? 'owner' : 'member';
}

/**
 * Owner-only controls that have no member line of their own (limits, the
 * export/erase block, who manages the team). False while the role is pending.
 */
export function useIsWorkspaceOwner(): boolean {
  return useWorkspaceRole() === 'owner';
}
