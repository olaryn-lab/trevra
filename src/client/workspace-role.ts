import type { WorkspaceRole as ResolvedWorkspaceRole } from '../server/roles';

/**
 * `pending` until BOTH the organization and the member read have resolved, so
 * a panel can hold back the owner controls AND the member's read-only line:
 * an owner on a hard reload must not see "Only the workspace owner can ..."
 * flash on, and a member must not see an owner control flash on.
 *
 * Kept apart from auth-client.ts (which builds the Better Auth client on
 * import) so pure view helpers and their tests can use it without a browser.
 */
export type WorkspaceRole = 'pending' | ResolvedWorkspaceRole;

/**
 * The resolved non-owner case for panels that show a read-only line instead
 * of an owner control: a manager reads the same line a member does.
 */
export function lacksOwnerRole(role: WorkspaceRole): boolean {
  return role === 'member' || role === 'manager';
}
