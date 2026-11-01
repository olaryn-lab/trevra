/**
 * LinkedIn campaign tools for an agent (TRV-054): prepare a campaign for named
 * people and a sequence, start it, and read its progress.
 *
 * WHAT THESE TOOLS CANNOT DO is the design, so it comes first. None of them
 * approves, sends or executes anything (tools.ts' invariant). Starting a
 * campaign only lets the runner PLAN actions; every invite and message of a
 * campaign an agent prepared is held for a person to approve its exact content
 * (`reviewLinkedInAction`, the agent-prepared rule), even where a workspace
 * policy would let a person's own campaign send unattended.
 *
 * An agent acts with its token creator's CURRENT workspace role, read at call
 * time, never more. A creator who was demoted or removed takes the agent's
 * reach down with them on the next call. The checks mirror the session routes:
 * seat use needs `campaigns.manage_all` or the seat's owner, and an agent may
 * start only a draft campaign it prepared itself -- never a person's draft,
 * and never a resume of something somebody paused.
 */

import { z } from 'zod/v3';
import type { Db } from '../db.js';
import { hasCapability, parseWorkspaceRole, type WorkspaceRole } from '../roles.js';
import { listSeats, getSeat, effectivePosture } from '../linkedin/seats.js';
import { companionWorkspaceReady } from '../linkedin/companion.js';
import {
  getManagedCampaign,
  listCampaignMembers,
  recordManagedCampaignAudit,
  startManagedCampaign
} from '../linkedin/managed-campaigns.js';
import { listLinkedInActionReviews } from '../linkedin/action-policy.js';
import { workflowStepsSchema, type WorkflowStep } from '../linkedin/workflows.js';
import { pastedProfileRejectionReason, pastedProfileUrl } from '../linkedin/lead-import.js';
import { prepareOutreach } from '../outreach/prepare.js';
import { loadEntitlements } from '../billing/entitlements.js';
import { assertCampaignActivation } from '../billing/boundaries.js';
import type { AgentToolContext, AgentToolDefinition } from './tools.js';

/** Most people one preparation takes. More is refused, never truncated. */
export const AGENT_PEOPLE_LIMIT = 100;

/**
 * Steps an agent's sequence may use: LinkedIn only. Email, InMail and email
 * finding spend credits or reach another channel, and stay a person's choice
 * made in Trevra. `withdraw_pending` is left out too: withdrawals are decided
 * by their own policy path (withdrawal-policy.ts), which the agent-prepared
 * rule in action-policy.ts does not cover, so a workspace `allow` could let one
 * through unread.
 */
export const AGENT_SEQUENCE_ACTIONS: ReadonlySet<WorkflowStep['action']> = new Set([
  'profile_view',
  'connection_request',
  'message',
  'wait',
  'condition',
  'monitor',
  'end'
]);

const AGENT_CONDITION_KINDS = new Set(['connected', 'accepted', 'replied', 'open_profile']);

/** One line of text: a newline inside a name would be a different CSV row. */
const singleLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/[\r\n]/.test(value), 'must be a single line');

const personSchema = z
  .object({
    profileUrl: z.string().trim().min(1).max(500),
    firstName: singleLine(100),
    lastName: singleLine(100),
    company: singleLine(200)
  })
  .strict();

const prepareSchema = z
  .object({
    idempotencyKey: z.string().trim().min(8).max(200),
    name: z.string().trim().min(1).max(160),
    seatKey: z.string().trim().min(1).max(64),
    people: z.array(personSchema).min(1),
    steps: z.array(z.unknown()).min(1).max(100)
  })
  .strict();

const campaignIdSchema = z.object({ campaignId: z.string().trim().min(1).max(160) }).strict();

class AgentCampaignRefusal extends Error {}

type SeatRow = Awaited<ReturnType<typeof listSeats>>[number];

/**
 * The token creator's role in this workspace, read now. The same answers the
 * session path gives: a Better Auth account's `member` row is the role; a home
 * workspace with no member row is the least-privileged `member`; a Trevra user
 * with no Better Auth account (the hand-rolled demo session) owns their home
 * workspace. Anything else -- no creator, a creator removed from this
 * workspace -- is refused.
 */
export async function agentCreatorRole(
  db: Db,
  workspaceId: string,
  userId: string | null | undefined
): Promise<{ userId: string; role: WorkspaceRole }> {
  if (!userId)
    throw new AgentCampaignRefusal(
      'This agent token has no person behind it, so it cannot work with LinkedIn campaigns. Create a token in Trevra under Setup, Advanced.'
    );
  const user = await db
    .prepare('SELECT id,email,workspace_id FROM users WHERE id=?')
    .get<{ id: string; email: string; workspace_id: string }>(userId);
  const refused = new AgentCampaignRefusal(
    'The person who created this agent token is no longer a member of this workspace.'
  );
  if (!user) throw refused;
  const authUser = await db
    .prepare('SELECT id FROM "user" WHERE lower(email)=lower(?) LIMIT 1')
    .get<{ id: string }>(user.email);
  if (!authUser) {
    if (user.workspace_id === workspaceId) return { userId: user.id, role: 'owner' };
    throw refused;
  }
  const member = await db
    .prepare('SELECT role FROM member WHERE "organizationId"=? AND "userId"=? LIMIT 1')
    .get<{ role: string }>(workspaceId, authUser.id);
  if (member) return { userId: user.id, role: parseWorkspaceRole(member.role) };
  if (user.workspace_id === workspaceId) return { userId: user.id, role: 'member' };
  throw refused;
}

function mayUseSeat(seat: SeatRow, creator: { userId: string; role: WorkspaceRole }): boolean {
  return hasCapability(creator.role, 'campaigns.manage_all') || seat.ownerUserId === creator.userId;
}

/** Refuses any step an agent's sequence may not carry. Shape is checked later, by the schema. */
export function assertAgentSequence(steps: readonly unknown[]): void {
  steps.forEach((raw, index) => {
    const step = (raw ?? {}) as { action?: unknown; config?: Record<string, unknown> };
    const action = typeof step.action === 'string' ? step.action : '';
    if (!AGENT_SEQUENCE_ACTIONS.has(action as WorkflowStep['action']))
      throw new AgentCampaignRefusal(
        `Step ${index + 1} (${action || 'no action'}) is not available to an agent. Use ${[
          ...AGENT_SEQUENCE_ACTIONS
        ].join(', ')}.`
      );
    const condition = step.config?.condition as { kind?: unknown } | undefined;
    if (condition && !AGENT_CONDITION_KINDS.has(String(condition.kind)))
      throw new AgentCampaignRefusal(
        `Step ${index + 1} checks '${String(condition.kind)}'. An agent may check only ${[
          ...AGENT_CONDITION_KINDS
        ].join(', ')}.`
      );
    const variants = Array.isArray(step.config?.variants) ? step.config.variants : [];
    if (
      variants.some((variant) => {
        const value = (variant ?? {}) as Record<string, unknown>;
        return Boolean(value.attachmentUrl || value.attachmentName || value.mediaKind);
      })
    )
      throw new AgentCampaignRefusal(
        `Step ${index + 1} has an attachment. Attachments are added by a person in Trevra.`
      );
  });
  const parsed = workflowStepsSchema.safeParse(steps);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? ` (steps.${issue.path.join('.')})` : '';
    throw new AgentCampaignRefusal(
      `The sequence is not valid: ${issue?.message ?? 'invalid steps'}${where}`
    );
  }
}

/**
 * The people as a CSV for the ordinary import path, so they are deduplicated,
 * linked to People and checked for campaign eligibility exactly like an
 * uploaded file. Each profile URL must be a real /in/ profile: the CSV reader
 * alone would take a bare word for a vanity handle.
 */
export function agentPeopleCsv(people: ReadonlyArray<z.infer<typeof personSchema>>): string {
  const seen = new Set<string>();
  const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const rows = people.map((person, index) => {
    const profileUrl = pastedProfileUrl(person.profileUrl);
    if (!profileUrl)
      throw new AgentCampaignRefusal(
        `people[${index}].profileUrl: ${pastedProfileRejectionReason(person.profileUrl)}`
      );
    const key = profileUrl.toLowerCase();
    if (seen.has(key))
      throw new AgentCampaignRefusal(`people[${index}].profileUrl repeats an earlier person.`);
    seen.add(key);
    return [person.firstName, person.lastName, person.company, profileUrl].map(quote).join(',');
  });
  return ['first_name,last_name,company,linkedin', ...rows].join('\r\n');
}

function parseArgs<T>(schema: z.ZodType<T>, args: Record<string, unknown>): T {
  const parsed = schema.safeParse(args);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  throw new AgentCampaignRefusal(`${where}${issue?.message ?? 'invalid input'}`);
}

async function preparedBy(db: Db, workspaceId: string, campaignId: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT prepared_by_agent_id FROM linkedin_campaigns WHERE workspace_id=? AND id=?')
    .get<{ prepared_by_agent_id: string | null }>(workspaceId, campaignId);
  return row?.prepared_by_agent_id ?? null;
}

const campaignHref = (campaignId: string) => `/outreach/campaign/${encodeURIComponent(campaignId)}`;

async function listSeatsForAgent(ctx: AgentToolContext) {
  const now = new Date();
  const [seats, companionReady] = await Promise.all([
    listSeats(ctx.db, ctx.workspaceId),
    companionWorkspaceReady(ctx.db, ctx.workspaceId, now)
  ]);
  return {
    companionReady,
    seats: seats.map((seat) => ({
      seatKey: seat.seatKey,
      label: seat.label,
      ownerName: seat.ownerName,
      ownedByTokenCreator: Boolean(ctx.userId) && seat.ownerUserId === ctx.userId,
      sendMode: seat.sendMode,
      posture: effectivePosture(seat, now),
      pausedReason: seat.pausedReason,
      timezone: seat.timezone,
      workingDays: seat.workingDays,
      workStartMinute: seat.workStartMinute,
      workEndMinute: seat.workEndMinute,
      dailyInviteLimit: seat.dailyInviteLimit,
      dailyMessageLimit: seat.dailyMessageLimit,
      sessionValidAt: seat.sessionValidAt
    }))
  };
}

async function prepareCampaignForAgent(ctx: AgentToolContext, args: Record<string, unknown>) {
  const input = parseArgs(prepareSchema, args);
  if (input.people.length > AGENT_PEOPLE_LIMIT)
    throw new AgentCampaignRefusal(
      `At most ${AGENT_PEOPLE_LIMIT} people per campaign. Split the list into more campaigns.`
    );
  const peopleCsv = agentPeopleCsv(input.people);
  assertAgentSequence(input.steps);
  const creator = await agentCreatorRole(ctx.db, ctx.workspaceId, ctx.userId);
  const seat = await getSeat(ctx.db, ctx.workspaceId, input.seatKey);
  if (!seat) throw new AgentCampaignRefusal(`LinkedIn account '${input.seatKey}' was not found.`);
  if (!mayUseSeat(seat, creator))
    throw new AgentCampaignRefusal(
      `Only the owner of “${seat.label}”, or a workspace owner or manager, can prepare campaigns with it.`
    );
  const now = new Date();
  const result = await prepareOutreach(
    ctx.db,
    {
      workspaceId: ctx.workspaceId,
      actorUserId: creator.userId,
      idempotencyKey: input.idempotencyKey,
      name: input.name,
      senderKey: seat.seatKey,
      uploadedPeopleCsv: peopleCsv,
      steps: input.steps,
      preparedByAgentId: ctx.actorId
    },
    now
  );
  // Once per campaign, including when a retry is what finished creating it.
  const audited = await ctx.db
    .prepare(
      `SELECT 1 AS ok FROM audit_events WHERE workspace_id=? AND entity_type='linkedin_campaign'
         AND entity_id=? AND event_type='linkedin_campaign.created' LIMIT 1`
    )
    .get<{ ok: number }>(ctx.workspaceId, result.artifacts.campaignId);
  if (!audited)
    await recordManagedCampaignAudit(
      ctx.db,
      {
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        actorType: 'agent',
        eventType: 'linkedin_campaign.created',
        entityType: 'linkedin_campaign',
        entityId: result.artifacts.campaignId,
        metadata: {
          leadListId: result.artifacts.leadListId,
          workflowId: result.artifacts.workflowId,
          senderKeys: [seat.seatKey],
          onBehalfOfUserId: creator.userId
        }
      },
      now
    );
  return {
    ...result,
    submittedPeople: input.people.length,
    next: {
      ...result.next,
      instruction:
        'The campaign is a draft. Start it with trevra_start_linkedin_campaign. Every invite and message then waits for a person to approve it in Trevra.'
    }
  };
}

async function startCampaignForAgent(ctx: AgentToolContext, args: Record<string, unknown>) {
  const { campaignId } = parseArgs(campaignIdSchema, args);
  const creator = await agentCreatorRole(ctx.db, ctx.workspaceId, ctx.userId);
  const campaign = await getManagedCampaign(ctx.db, ctx.workspaceId, campaignId);
  // A campaign another agent or a person made answers like one that does not
  // exist: this tool's whole reach is the agent's own drafts.
  if (!campaign || (await preparedBy(ctx.db, ctx.workspaceId, campaignId)) !== ctx.actorId)
    throw new AgentCampaignRefusal('No campaign this agent prepared has that id.');
  if (
    !hasCapability(creator.role, 'campaigns.manage_all') &&
    campaign.ownerUserId !== creator.userId
  )
    throw new AgentCampaignRefusal(
      'Only the campaign owner or a workspace owner or manager can start this campaign.'
    );
  for (const seatKey of new Set(campaign.senderKeys)) {
    const seat = await getSeat(ctx.db, ctx.workspaceId, seatKey);
    if (!seat) throw new AgentCampaignRefusal(`LinkedIn account '${seatKey}' was not found.`);
    if (!mayUseSeat(seat, creator))
      throw new AgentCampaignRefusal(
        `Only the owner of “${seat.label}”, or a workspace owner or manager, can start this campaign.`
      );
  }
  const instruction =
    'Running. Trevra plans each step inside the account’s working hours and limits. Every invite and message waits for a person to approve it in Trevra before anything is sent.';
  if (campaign.status === 'running')
    return {
      campaign,
      alreadyRunning: true,
      next: { href: campaignHref(campaignId), instruction }
    };
  if (campaign.status !== 'draft')
    throw new AgentCampaignRefusal(
      `This campaign is ${campaign.status}. An agent may start only a draft; resuming or restarting is done by a person in Trevra.`
    );
  const now = new Date();
  const entitlements = await loadEntitlements(ctx.db, ctx.workspaceId);
  const started = await startManagedCampaign(ctx.db, ctx.workspaceId, campaignId, now, {
    // Checked again under the row lock: a person may have paused or stopped
    // the draft since it was read above, and that decision wins.
    beforeActivate: async (tx) => {
      const current = await tx
        .prepare('SELECT status FROM linkedin_campaigns WHERE workspace_id=? AND id=?')
        .get<{ status: string }>(ctx.workspaceId, campaignId);
      if (current?.status !== 'draft')
        throw new AgentCampaignRefusal(
          `This campaign is ${current?.status ?? 'gone'}. An agent may start only a draft.`
        );
      await assertCampaignActivation(tx, entitlements, ctx.workspaceId);
    }
  });
  await recordManagedCampaignAudit(
    ctx.db,
    {
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      actorType: 'agent',
      eventType: 'linkedin_campaign.started',
      entityType: 'linkedin_campaign',
      entityId: campaignId,
      metadata: { workflowVersion: started.workflowVersion, onBehalfOfUserId: creator.userId }
    },
    now
  );
  return {
    campaign: started,
    alreadyRunning: false,
    next: { href: campaignHref(campaignId), instruction }
  };
}

async function getCampaignForAgent(ctx: AgentToolContext, args: Record<string, unknown>) {
  const { campaignId } = parseArgs(campaignIdSchema, args);
  const campaign = await getManagedCampaign(ctx.db, ctx.workspaceId, campaignId);
  if (!campaign) throw new AgentCampaignRefusal('Campaign not found.');
  const [members, actions, reviews, preparedByAgentId] = await Promise.all([
    listCampaignMembers(ctx.db, ctx.workspaceId, campaignId),
    ctx.db
      .prepare(
        `SELECT id,campaign_member_id,kind,status,planned_for,recorded_at,accepted_at,failure_kind
         FROM linkedin_actions WHERE workspace_id=? AND campaign_id=?
         ORDER BY created_at,id LIMIT 500`
      )
      .all<{
        id: string;
        campaign_member_id: string | null;
        kind: string;
        status: string;
        planned_for: string | null;
        recorded_at: string | null;
        accepted_at: string | null;
        failure_kind: string | null;
      }>(ctx.workspaceId, campaignId),
    listLinkedInActionReviews(ctx.db, ctx.workspaceId, campaignId),
    preparedBy(ctx.db, ctx.workspaceId, campaignId)
  ]);
  const iso = (value: unknown) => {
    if (value == null) return null;
    const at = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(at.getTime()) ? String(value) : at.toISOString();
  };
  return {
    campaign: {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      senderKeys: campaign.senderKeys,
      startedAt: campaign.startedAt,
      pausedAt: campaign.pausedAt,
      preparedByThisAgent: preparedByAgentId === ctx.actorId,
      counts: {
        members: campaign.memberCount,
        pending: campaign.pendingCount,
        inSequence: campaign.inSequenceCount,
        waiting: campaign.waitingCount,
        replied: campaign.repliedCount,
        completed: campaign.completedCount,
        failed: campaign.failedCount,
        excluded: campaign.excludedCount
      },
      steps: campaign.steps
    },
    members: members.map((member) => ({
      id: member.id,
      name: `${member.firstName} ${member.lastName}`.trim(),
      profileUrl: member.profileUrl,
      status: member.status,
      currentStepId: member.currentStepId,
      completedStepIds: member.completedStepIds,
      nextEligibleAt: member.nextEligibleAt,
      exclusionReason: member.exclusionReason,
      lastFailureReason: member.lastFailureReason
    })),
    actions: actions.map((action) => ({
      id: action.id,
      memberId: action.campaign_member_id,
      kind: action.kind,
      status: action.status,
      plannedFor: iso(action.planned_for),
      recordedAt: iso(action.recorded_at),
      acceptedAt: iso(action.accepted_at),
      failureKind: action.failure_kind
    })),
    awaitingApproval: reviews.map((review) => ({
      actionId: review.actionId,
      kind: review.kind,
      subject: review.subject,
      body: review.body,
      policy: review.policy.policyName,
      reason: review.policy.reason
    })),
    next: {
      href: campaignHref(campaignId),
      instruction: reviews.length
        ? `${reviews.length} LinkedIn write(s) wait for a person to approve them in Trevra.`
        : 'Nothing is waiting for approval right now.'
    }
  };
}

export const LINKEDIN_CAMPAIGN_AGENT_TOOLS: readonly AgentToolDefinition[] = [
  {
    name: 'trevra_list_linkedin_seats',
    title: 'List LinkedIn accounts',
    description:
      'List the LinkedIn accounts (seats) in this workspace: who owns each, its send mode, posture, working hours and daily limits, and whether the Companion is online to carry out approved actions.',
    scope: 'workspace:read',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    run: (ctx) => listSeatsForAgent(ctx)
  },
  {
    name: 'trevra_prepare_linkedin_campaign',
    title: 'Prepare a LinkedIn campaign',
    description: `Create a DRAFT LinkedIn campaign for up to ${AGENT_PEOPLE_LIMIT} people (profile URL, first name, last name, company) and a LinkedIn-only sequence (profile_view, connection_request, message, wait, condition, monitor, end). Nothing is sent. Retrying with the same idempotencyKey and input returns the same campaign.`,
    scope: 'outreach:prepare',
    inputSchema: {
      type: 'object',
      properties: {
        idempotencyKey: { type: 'string', minLength: 8, maxLength: 200 },
        name: { type: 'string', minLength: 1, maxLength: 160 },
        seatKey: { type: 'string', description: 'From trevra_list_linkedin_seats.' },
        people: {
          type: 'array',
          minItems: 1,
          maxItems: AGENT_PEOPLE_LIMIT,
          items: {
            type: 'object',
            properties: {
              profileUrl: { type: 'string', description: 'https://www.linkedin.com/in/<handle>/' },
              firstName: { type: 'string' },
              lastName: { type: 'string' },
              company: { type: 'string' }
            },
            required: ['profileUrl', 'firstName', 'lastName', 'company'],
            additionalProperties: false
          }
        },
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          description:
            'Workflow steps: {id, action, delayBefore?: {amount, unit}, config}. connection_request config: {message} (max 300 chars). message config: {variants: [{id, body, weight}], requiresAcceptedConnection}.',
          items: { type: 'object', additionalProperties: true }
        }
      },
      required: ['idempotencyKey', 'name', 'seatKey', 'people', 'steps'],
      additionalProperties: false
    },
    readOnly: false,
    destructive: false,
    idempotent: true,
    openWorld: false,
    run: (ctx, args) => prepareCampaignForAgent(ctx, args)
  },
  {
    name: 'trevra_start_linkedin_campaign',
    title: 'Start a LinkedIn campaign this agent prepared',
    description:
      'Start a draft campaign this agent prepared. Trevra then plans each step within the account’s working hours and limits, and holds every invite and message until a person approves its exact content in Trevra. Cannot resume a paused campaign.',
    scope: 'outreach:prepare',
    inputSchema: {
      type: 'object',
      properties: { campaignId: { type: 'string' } },
      required: ['campaignId'],
      additionalProperties: false
    },
    readOnly: false,
    destructive: false,
    idempotent: true,
    openWorld: false,
    run: (ctx, args) => startCampaignForAgent(ctx, args)
  },
  {
    name: 'trevra_get_linkedin_campaign',
    title: 'Get LinkedIn campaign progress',
    description:
      'Read one LinkedIn campaign: status, each person’s progress, planned and completed actions (including acceptance), replies, and the writes waiting for approval.',
    scope: 'workspace:read',
    inputSchema: {
      type: 'object',
      properties: { campaignId: { type: 'string' } },
      required: ['campaignId'],
      additionalProperties: false
    },
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    run: (ctx, args) => getCampaignForAgent(ctx, args)
  }
];
