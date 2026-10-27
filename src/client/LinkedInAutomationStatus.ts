import type { ManagedCampaign, CampaignQueueSummary } from '../server/linkedin/managed-campaigns';
import type { LinkedInCampaignExecution } from '../server/linkedin/execution-state';
import { campaignExecutionBlocker } from './LinkedInExecutionBlocker';
import type { LinkedInSeat } from '../server/linkedin/seats';
import type { LinkedInCompanionStatus, LinkedInSeatResponse, LinkedInWorkerStatus } from './api';

export type LinkedInAutomationSummary = {
  kind: 'checking' | 'setup' | 'attention' | 'paused' | 'waiting' | 'working';
  title: string;
  description: string;
  nextStep: string | null;
};

/** One answer ordered by the conditions that actually prevent execution. */
export function linkedInAutomationStatus(input: {
  accounts: readonly LinkedInSeat[] | null;
  details: Readonly<Record<string, LinkedInSeatResponse>>;
  worker: LinkedInWorkerStatus | null;
  companion: LinkedInCompanionStatus | null;
  campaigns: readonly ManagedCampaign[] | null;
  operations?: Readonly<
    Record<string, { queues: CampaignQueueSummary; execution?: LinkedInCampaignExecution } | null>
  >;
}): LinkedInAutomationSummary {
  const { accounts, details, worker, companion, campaigns, operations } = input;
  if (accounts === null || !worker || campaigns === null || (worker.companionBrowser && !companion))
    return {
      kind: 'checking',
      title: 'Checking LinkedIn',
      description: 'Reading your account and campaign status.',
      nextStep: null
    };
  if (accounts.length === 0)
    return {
      kind: 'setup',
      title: 'Connect LinkedIn',
      description: 'Add a LinkedIn account to get started.',
      nextStep: 'Add an account below.'
    };
  if (!worker.enabled || !worker.ready)
    return {
      kind: 'attention',
      title: 'Needs attention',
      description: 'LinkedIn automation is unavailable on this server.',
      nextStep: 'Open connection details below.'
    };
  if (worker.companionBrowser) {
    if (!companion?.devices.some((device) => device.online))
      return {
        kind: 'attention',
        title: 'Needs attention',
        description: companion?.devices.length
          ? 'Your connected computer is offline.'
          : 'No computer is connected for LinkedIn.',
        nextStep: 'Open connection details to reconnect your computer.'
      };
    if (companion.attention.length > 0 || companion.recoveries.length > 0)
      return {
        kind: 'attention',
        title: 'Needs attention',
        description: 'LinkedIn needs a sign-in or verification on your computer.',
        nextStep: 'Finish the check in the Companion window, then close that window.'
      };
  }

  const active = accounts.filter(
    (account) => account.posture !== 'paused' && account.posture !== 'cooldown'
  );
  if (active.length === 0)
    return {
      kind: 'paused',
      title: 'Paused',
      description: 'LinkedIn is paused for every account.',
      nextStep: 'Resume an account below when you want automation to run.'
    };
  if (!active.some((account) => Boolean(details[account.seatKey]?.auth.sessionValidAt)))
    return {
      kind: 'attention',
      title: 'Needs attention',
      description: 'Trevra has not confirmed a LinkedIn sign-in for an active account.',
      nextStep: 'Check your LinkedIn account below.'
    };

  const activeKeys = new Set(active.map((account) => account.seatKey));
  const related = campaigns.filter(
    (campaign) =>
      activeKeys.has(campaign.seatKey) || campaign.senderKeys.some((key) => activeKeys.has(key))
  );
  const runningCampaigns = related.filter((campaign) => campaign.status === 'running');
  const running = runningCampaigns.length;
  const paused = related.filter((campaign) => campaign.status === 'paused').length;
  if (running > 0) {
    // Campaign status alone does NOT say anything about deliverable work. Get
    // the actual claimable/parked rows and the existing execution blocker.
    // Never silently call an unknown state Working.
    if (!operations || runningCampaigns.some((campaign) => operations[campaign.id] === undefined))
      return {
        kind: 'checking',
        title: 'Checking campaigns',
        description: 'Confirming which approved LinkedIn actions can run.',
        nextStep: null
      };
    if (runningCampaigns.some((campaign) => operations[campaign.id] === null))
      return {
        kind: 'attention',
        title: 'Needs attention',
        description: 'Trevra could not check whether this campaign can send.',
        nextStep: 'Refresh the page. If this continues, inspect campaign execution details.'
      };

    const blockers = runningCampaigns.map((campaign) => {
      const report = operations[campaign.id]!;
      return {
        report,
        blocker: campaignExecutionBlocker({
          senderKeys: campaign.senderKeys,
          queues: report.queues,
          execution: report.execution ?? null,
          workerStatus: worker,
          companionStatus: companion,
          now: Date.now()
        })
      };
    });
    const attention = blockers.find((item) => item.blocker?.severity === 'attention');
    if (attention)
      return {
        kind: 'attention',
        title: 'Needs attention',
        description: attention.blocker!.title,
        nextStep: attention.blocker!.detail
      };
    const waiting = blockers.find((item) => item.blocker?.severity === 'waiting');
    if (waiting)
      return {
        kind: 'waiting',
        title: 'Waiting',
        description: waiting.blocker!.title,
        nextStep: waiting.blocker!.detail
      };
    const executing = blockers.reduce((total, item) => total + item.report.queues.executing, 0);
    const ready = blockers.reduce((total, item) => total + item.report.queues.queuedReady, 0);
    if (ready + executing === 0)
      return {
        kind: 'waiting',
        title: 'Waiting for the next action',
        description: 'Campaigns are running, but no approved LinkedIn action is due yet.',
        nextStep: 'Trevra will continue when the next scheduled action becomes eligible.'
      };
    return {
      kind: 'working',
      title: 'Working',
      description:
        String(running) +
        (running === 1 ? ' campaign is' : ' campaigns are') +
        ' running, with approved actions eligible for execution.',
      nextStep: null
    };
  }
  return {
    kind: 'waiting',
    title: 'Waiting for a campaign',
    description:
      paused > 0
        ? String(paused) +
          (paused === 1 ? ' campaign is' : ' campaigns are') +
          ' paused. Your LinkedIn account and computer are ready.'
        : 'Your LinkedIn account is connected, but no campaign is running.',
    nextStep: 'Start or resume a campaign to begin approved outreach.'
  };
}
