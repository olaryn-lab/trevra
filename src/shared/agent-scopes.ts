/**
 * Agent-token scopes, shared by the server (which enforces them) and the Setup
 * screen (which grants them), so the two cannot disagree about the defaults.
 */
export const AGENT_SCOPES = [
  'skills:read',
  'skills:run',
  'runs:read',
  'workspace:read',
  'playbooks:read',
  'playbooks:run',
  'workflows:read',
  /**
   * Prepare and start LinkedIn campaigns (TRV-054). OPT-IN: never granted by
   * default. It cannot approve or send; every LinkedIn write of a campaign it
   * prepares waits for a person to approve the exact content.
   */
  'outreach:prepare'
] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

/** What a token gets when its creator names no scopes. Excludes `outreach:prepare`. */
export const DEFAULT_AGENT_SCOPES: readonly AgentScope[] = AGENT_SCOPES.filter(
  (scope) => scope !== 'outreach:prepare'
);
