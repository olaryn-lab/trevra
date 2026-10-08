import type { WorkspaceRole } from '../auth-client';
import { usd } from './format';

export interface HostedRunBlockerInput {
  /** Only `member` gets "the workspace owner has to ..." wording; owner and pending read as owner copy. */
  role: WorkspaceRole;
  dirtyCap: boolean;
  modelAccessDirty: boolean;
  /** Neither a stored API key against an endpoint nor a ready subscription CLI. */
  modelAccessMissing: boolean;
  spendingEnabled: boolean;
  capReached: boolean;
  monthlyCapCents: number;
  agentId: string;
  goal: string;
}

/** Why "Run now" is off, or null. Members are told to ask the owner for what only the owner can change. */
export function hostedRunBlocker(input: HostedRunBlockerInput): string | null {
  const member = input.role === 'member';
  if (input.dirtyCap)
    return 'Save the spending limit first — a run uses what is stored, not what is typed.';
  if (input.modelAccessDirty)
    return 'Save model access first — a run uses what is stored, not what is typed.';
  if (input.modelAccessMissing)
    return member
      ? 'The workspace owner has to configure model access before a hosted run can start.'
      : 'Configure model access before starting a hosted run.';
  if (!input.spendingEnabled)
    return member
      ? 'The workspace owner has to turn on model spending before a hosted run can start.'
      : 'Turn on model spending before starting a hosted run.';
  if (input.capReached)
    return `This month’s ${usd(input.monthlyCapCents)} is used up. ${
      member ? 'The workspace owner can raise the limit.' : 'Raise the limit to run again.'
    }`;
  if (!input.agentId) return 'Choose an active Agent first.';
  if (!input.goal.trim()) return 'Write the job you want this Agent to do.';
  return null;
}
