import { z } from 'zod';
import type { Db } from '../db.js';
import { importAccounts } from '../accounts/store.js';
import type { AccountImportResult } from '../accounts/types.js';
import { canonicalPayloadHash } from '../control-plane/payload.js';
import { listSeats } from '../linkedin/seats.js';
import { createCaptureSource } from '../lead-capture/sources.js';
import {
  CAPTURE_SOURCE_KINDS,
  type CaptureSourceKind,
  type CaptureSourceRecord
} from '../lead-capture/types.js';
import { secretsConfigured } from '../secrets/crypto.js';
import { emailComplianceFooterUnavailable, emailComplianceProvider } from '../email/compliance.js';
import {
  EmailOutreachError,
  emailOutreachReadiness,
  prepareEmailOutreach
} from '../email/outreach.js';
import type { PreparedEmailOutreachResult } from '../email/types.js';
import { footerForUnsubscribeMode } from '../email/unsubscribe-policy.js';
import { ZOHO_OUTREACH_DAILY_CAP } from '../email/zoho-mail.js';
import {
  DEFAULT_LINKEDIN_OUTREACH_WORKFLOW_NAME,
  prepareOutreach,
  type PreparedOutreachResult
} from '../outreach/prepare.js';

export const GTM_OBJECTIVES = [
  'find_accounts',
  'research_accounts',
  'prepare_outreach',
  'watch_accounts',
  'capture_inbound'
] as const;

export type GtmObjective = (typeof GTM_OBJECTIVES)[number];

const audienceSchema = z
  .object({
    description: z.string().trim().min(1).max(500).optional(),
    domains: z.array(z.string().trim().min(1).max(253)).max(500).optional(),
    countries: z.array(z.string().trim().min(2).max(80)).max(100).optional(),
    vertical: z.string().trim().min(1).max(120).optional(),
    quantity: z.number().int().min(1).max(500).optional()
  })
  .strict();

const peopleSchema = z
  .object({
    existingListId: z.string().trim().min(1).max(160).optional(),
    uploadedInputRef: z.string().trim().min(1).max(500).optional(),
    personaDescription: z.string().trim().min(1).max(500).optional()
  })
  .strict();

const timingSchema = z
  .object({
    start: z.string().datetime().optional(),
    recurring: z.boolean().optional()
  })
  .strict();

const captureSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    kind: z.enum(CAPTURE_SOURCE_KINDS).optional()
  })
  .strict();
export const gtmIntentSchema = z
  .object({
    objective: z.enum(GTM_OBJECTIVES),
    audience: audienceSchema.optional(),
    people: peopleSchema.optional(),
    capture: captureSchema.optional(),
    channels: z
      .array(z.enum(['linkedin', 'email', 'community']))
      .max(3)
      .optional(),
    autonomy: z.enum(['prepare_only', 'approval_required']).optional(),
    timing: timingSchema.optional()
  })
  .strict();

export type GtmIntent = z.infer<typeof gtmIntentSchema>;

export interface GtmPlanStep {
  kind: string;
  title: string;
  detail: string;
  externalEffect: boolean;
}

export interface GtmPlanBlocker {
  code: string;
  message: string;
  actionHref?: string;
}

export interface GtmPlan {
  objective: GtmObjective;
  intent: GtmIntent;
  summary: string;
  steps: GtmPlanStep[];
  blockers: GtmPlanBlocker[];
  defaults: Record<string, unknown>;
  consequences: {
    createsInternalState: boolean;
    externalWrites: boolean;
    approvalRequired: boolean;
  };
  next: {
    kind: string;
    href: string;
  };
  planHash: string;
}

export interface PreparedOutreachGtmPlanResult {
  status: 'prepared';
  objective: 'prepare_outreach';
  channel: 'linkedin';
  artifacts: PreparedOutreachResult['artifacts'];
  next: PreparedOutreachResult['next'];
  result: PreparedOutreachResult;
}

export interface PreparedCaptureGtmPlanResult {
  status: 'prepared';
  objective: 'capture_inbound';
  artifacts: { captureSourceId: string };
  next: { kind: 'configure_capture_source'; href: '/setup/capture' };
  result: {
    source: CaptureSourceRecord;
    secret: string;
    duplicate: boolean;
  };
}

export interface PreparedWatchGtmPlanResult {
  status: 'prepared';
  objective: 'watch_accounts';
  artifacts: { accountIds: string[] };
  next: { kind: 'review_accounts'; href: '/research' };
  result: {
    accounts: Array<{
      id: string;
      domain: string;
      name: string;
      status: string;
      nextSweepAt: string | null;
    }>;
    rejected: AccountImportResult['rejected'];
    recurring: true;
  };
}

export interface PreparedEmailOutreachGtmPlanResult {
  status: 'prepared';
  objective: 'prepare_outreach';
  channel: 'email';
  artifacts: { runIds: string[] };
  next: { kind: 'review_email_approvals'; href: '/ledger' };
  result: PreparedEmailOutreachResult;
}

export type PreparedGtmPlanResult =
  | PreparedOutreachGtmPlanResult
  | PreparedEmailOutreachGtmPlanResult
  | PreparedCaptureGtmPlanResult
  | PreparedWatchGtmPlanResult;

const watchPreparationResultSchema = z
  .object({
    accounts: z.array(
      z
        .object({
          id: z.string(),
          domain: z.string(),
          name: z.string(),
          status: z.string(),
          nextSweepAt: z.string().nullable()
        })
        .strict()
    ),
    rejected: z.array(z.object({ line: z.string(), reason: z.string() }).strict()),
    recurring: z.literal(true)
  })
  .strict();

function stringArray(value: unknown): string[] {
  const parsed =
    typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return [];
          }
        })()
      : value;
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
}

async function prepareWatchAccounts(
  db: Db,
  input: {
    workspaceId: string;
    actorUserId: string;
    idempotencyKey: string;
    plan: GtmPlan;
  }
): Promise<PreparedWatchGtmPlanResult> {
  const domains = input.plan.intent.audience?.domains ?? [];
  if (domains.length === 0)
    throw new GtmPlanError('Watch accounts requires explicit domains.', 409);

  return db.transaction(async (tx) => {
    await tx
      .prepare('SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0))')
      .get(`${input.workspaceId}:watch:${input.idempotencyKey}`);

    const existing = await tx
      .prepare(
        `SELECT plan_hash,account_ids_json,result_json
         FROM account_watch_preparations
         WHERE workspace_id=? AND idempotency_key=? LIMIT 1`
      )
      .get<{ plan_hash: string; account_ids_json: unknown; result_json: unknown }>(
        input.workspaceId,
        input.idempotencyKey
      );
    if (existing) {
      if (existing.plan_hash !== input.plan.planHash) {
        throw new GtmPlanError(
          'This idempotency key was already used for a different watch plan.',
          409
        );
      }
      return {
        status: 'prepared',
        objective: 'watch_accounts',
        artifacts: { accountIds: stringArray(existing.account_ids_json).sort() },
        next: { kind: 'review_accounts', href: '/research' },
        result: watchPreparationResultSchema.parse(existing.result_json)
      };
    }

    const imported = await importAccounts(tx, input.workspaceId, domains.join('\n'), {
      source: 'manual',
      icpNote: input.plan.intent.audience?.description ?? null
    });
    const inactive = imported.accounts.filter((account) => account.status !== 'active');
    if (inactive.length > 0) {
      throw new GtmPlanError(
        `${inactive.length} named ${inactive.length === 1 ? 'account is' : 'accounts are'} no longer active. Re-plan before watching.`,
        409
      );
    }

    const accounts = imported.accounts
      .map((account) => ({
        id: account.id,
        domain: account.domain,
        name: account.name,
        status: account.status,
        nextSweepAt: account.nextSweepAt
      }))
      .sort(
        (left, right) => left.domain.localeCompare(right.domain) || left.id.localeCompare(right.id)
      );
    const accountIds = accounts.map((account) => account.id).sort();
    const result = {
      accounts,
      rejected: imported.rejected,
      recurring: true as const
    };

    await tx
      .prepare(
        `INSERT INTO account_watch_preparations
         (workspace_id,idempotency_key,plan_hash,actor_user_id,account_ids_json,result_json,created_at)
         VALUES (?,?,?,?,?::jsonb,?::jsonb,CURRENT_TIMESTAMP)`
      )
      .run(
        input.workspaceId,
        input.idempotencyKey,
        input.plan.planHash,
        input.actorUserId,
        JSON.stringify(accountIds),
        JSON.stringify(result)
      );

    return {
      status: 'prepared',
      objective: 'watch_accounts',
      artifacts: { accountIds },
      next: { kind: 'review_accounts', href: '/research' },
      result
    };
  });
}

export class GtmPlanError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
  }
}

const planStepSchema = z
  .object({
    kind: z.string().min(1),
    title: z.string().min(1),
    detail: z.string(),
    externalEffect: z.boolean()
  })
  .strict();

const blockerSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    actionHref: z.string().min(1).optional()
  })
  .strict();

const suppliedPlanSchema = z
  .object({
    objective: z.enum(GTM_OBJECTIVES),
    intent: gtmIntentSchema,
    summary: z.string().min(1),
    steps: z.array(planStepSchema),
    blockers: z.array(blockerSchema),
    defaults: z.record(z.unknown()),
    consequences: z
      .object({
        createsInternalState: z.boolean(),
        externalWrites: z.boolean(),
        approvalRequired: z.boolean()
      })
      .strict(),
    next: z.object({ kind: z.string().min(1), href: z.string().min(1) }).strict(),
    planHash: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();

function uniqueSorted(
  values: string[] | undefined,
  transform: (value: string) => string
): string[] | undefined {
  if (!values) return undefined;
  return [...new Set(values.map(transform).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right)
  );
}

function normalizeIntent(raw: unknown): GtmIntent {
  const parsed = gtmIntentSchema.parse(raw);
  const channels = parsed.channels
    ? ([...new Set(parsed.channels)].sort((left, right) =>
        left.localeCompare(right)
      ) as GtmIntent['channels'])
    : undefined;
  const audience = parsed.audience
    ? {
        ...parsed.audience,
        ...(parsed.audience.domains
          ? {
              domains: uniqueSorted(parsed.audience.domains, (value) =>
                value
                  .trim()
                  .toLowerCase()
                  .replace(/^https?:\/\//, '')
                  .replace(/^www\./, '')
                  .replace(/\/.*$/, '')
              )
            }
          : {}),
        ...(parsed.audience.countries
          ? {
              countries: uniqueSorted(parsed.audience.countries, (value) =>
                value.trim().toUpperCase()
              )
            }
          : {})
      }
    : undefined;
  return {
    ...parsed,
    ...(audience ? { audience } : {}),
    ...(parsed.people
      ? {
          people: {
            ...parsed.people,
            existingListId: parsed.people.existingListId?.trim(),
            uploadedInputRef: parsed.people.uploadedInputRef?.trim(),
            personaDescription: parsed.people.personaDescription?.trim()
          }
        }
      : {}),
    ...(channels ? { channels } : {}),
    autonomy: parsed.autonomy ?? 'approval_required'
  };
}

function audienceDescription(intent: GtmIntent): string {
  const audience = intent.audience;
  if (!audience) return 'the target audience';
  const parts = [
    audience.description,
    audience.vertical,
    audience.countries?.length ? audience.countries.join(', ') : null,
    audience.domains?.length ? `${audience.domains.length} named domains` : null
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'the target audience';
}

function hasAudience(intent: GtmIntent): boolean {
  const audience = intent.audience;
  return Boolean(
    audience?.description ||
    audience?.vertical ||
    audience?.countries?.length ||
    audience?.domains?.length
  );
}

function finalizePlan(plan: Omit<GtmPlan, 'planHash'>): GtmPlan {
  return { ...plan, planHash: canonicalPayloadHash(plan) };
}

/** People-source blockers shared by the LinkedIn and email outreach plans. */
function peopleBlockers(intent: GtmIntent): GtmPlanBlocker[] {
  const blockers: GtmPlanBlocker[] = [];
  const existingListId = intent.people?.existingListId ?? null;
  const uploadedInputRef = intent.people?.uploadedInputRef ?? null;
  if (!existingListId && !uploadedInputRef) {
    blockers.push({
      code: 'people_required',
      message: 'Choose known People before Trevra can prepare outreach.',
      actionHref: '/outreach/new'
    });
  }
  if (existingListId && uploadedInputRef) {
    blockers.push({
      code: 'people_source_ambiguous',
      message: 'Choose one People source, not both an existing list and an uploaded input.',
      actionHref: '/outreach/new'
    });
  }
  if (uploadedInputRef) {
    blockers.push({
      code: 'uploaded_input_not_materialized',
      message:
        'The generic compiler does not materialize uploaded-input references yet. Use Prepare outreach for CSV input.',
      actionHref: '/outreach/new'
    });
  }
  return blockers;
}

async function prepareOutreachPlan(
  db: Db,
  workspaceId: string,
  intent: GtmIntent
): Promise<GtmPlan> {
  const requestedChannels = intent.channels?.length ? intent.channels : ['linkedin'];
  if (requestedChannels.length === 1 && requestedChannels[0] === 'email') {
    return emailOutreachPlan(db, workspaceId, intent);
  }
  const blockers: GtmPlanBlocker[] = [];
  if (requestedChannels.length !== 1 || requestedChannels[0] !== 'linkedin') {
    blockers.push({
      code: 'prepare_outreach_single_channel',
      message: 'Prepare outreach for one channel at a time: LinkedIn or email.',
      actionHref: '/outreach/new'
    });
  }
  blockers.push(...peopleBlockers(intent));

  const existingListId = intent.people?.existingListId ?? null;

  const seats = await listSeats(db, workspaceId);
  let senderKey: string | null = seats.length === 1 ? seats[0]!.seatKey : null;
  let listName: string | null = null;
  if (existingListId) {
    const list = await db
      .prepare(
        'SELECT id,name,seat_key FROM linkedin_lead_lists WHERE workspace_id=? AND id=? LIMIT 1'
      )
      .get<{ id: string; name: string; seat_key: string }>(workspaceId, existingListId);
    if (!list) {
      blockers.push({
        code: 'lead_list_not_found',
        message: 'The selected People list no longer exists in this workspace.',
        actionHref: '/outreach/new'
      });
    } else {
      listName = list.name;
      senderKey = list.seat_key;
      if (!seats.some((seat) => seat.seatKey === list.seat_key)) {
        blockers.push({
          code: 'linkedin_sender_missing',
          message: 'The LinkedIn account attached to this People list is no longer connected.',
          actionHref: '/setup/workspace'
        });
      }
    }
  } else if (seats.length === 0) {
    blockers.push({
      code: 'linkedin_sender_missing',
      message: 'Connect the LinkedIn account you want Trevra to use.',
      actionHref: '/setup/workspace'
    });
  } else if (seats.length > 1) {
    blockers.push({
      code: 'linkedin_sender_ambiguous',
      message: 'Choose which LinkedIn account should own this outreach preparation.',
      actionHref: '/outreach/new'
    });
  }

  const summary = existingListId
    ? `Prepare LinkedIn outreach for ${listName ?? 'the selected People list'}`
    : 'Prepare LinkedIn outreach from known People';
  return finalizePlan({
    objective: 'prepare_outreach',
    intent,
    summary,
    steps: [
      {
        kind: 'people',
        title: 'People',
        detail: existingListId
          ? `Reuse People from ${listName ?? existingListId}.`
          : 'Resolve the supplied People input without inventing identities.',
        externalEffect: false
      },
      {
        kind: 'sequence',
        title: 'Sequence',
        detail: `Use ${DEFAULT_LINKEDIN_OUTREACH_WORKFLOW_NAME} with existing LinkedIn safety limits.`,
        externalEffect: false
      },
      {
        kind: 'campaign',
        title: 'Campaign ready for review',
        detail: 'Create a draft campaign only. Preparing it sends nothing.',
        externalEffect: false
      }
    ],
    blockers,
    defaults: {
      channel: 'linkedin',
      senderKey,
      leadListId: existingListId,
      workflowPreset: 'default',
      workflowName: DEFAULT_LINKEDIN_OUTREACH_WORKFLOW_NAME,
      prepareSupported: blockers.length === 0 && Boolean(existingListId && senderKey)
    },
    consequences: {
      createsInternalState: true,
      externalWrites: false,
      approvalRequired: true
    },
    next: { kind: 'review_outreach_plan', href: '/outreach/new' }
  });
}

async function emailOutreachPlan(db: Db, workspaceId: string, intent: GtmIntent): Promise<GtmPlan> {
  const blockers = peopleBlockers(intent);
  const existingListId = intent.people?.existingListId ?? null;
  const readiness = await emailOutreachReadiness(db, workspaceId, { leadListId: existingListId });
  blockers.push(...readiness.blockers);
  const provider = emailComplianceProvider();
  const compliance = [...(await provider.blockers(db, workspaceId, existingListId ?? null))];
  // Preparing refuses without a footer, so a plan that promises it can prepare
  // must not pass while the footer is missing. A provider issue that already
  // names the footer cause (sender_* or the generic code) is enough; any other
  // issue, such as a lead-list one, leaves a null footer unnamed, so add it.
  const footer = (await provider.footer(db, workspaceId))?.trim() ?? '';
  const footerNamed = compliance.some(
    (issue) =>
      issue.code === 'email_compliance_footer_unavailable' || issue.code.startsWith('sender_')
  );
  if (!footer && !footerNamed) compliance.push(emailComplianceFooterUnavailable());
  blockers.push(...compliance);
  // Zoho outreach swaps the footer's opt-out sentence for reply-to-unsubscribe;
  // without exactly one such sentence preparing would refuse.
  if (
    footer &&
    readiness.sender?.unsubscribeMode === 'footer_and_reply' &&
    !footerForUnsubscribeMode(footer, 'footer_and_reply')
  ) {
    blockers.push({
      code: 'email_opt_out_line_missing',
      message:
        'Your compliance footer needs its opt-out line exactly once so Trevra can turn it into "reply unsubscribe" for Zoho Mail. Complete sender compliance in Workspace settings.',
      actionHref: '/setup/workspace'
    });
  }
  const sender = readiness.sender;
  const listLabel = readiness.listName ?? 'the selected People list';
  return finalizePlan({
    objective: 'prepare_outreach',
    intent,
    summary: existingListId
      ? `Email ${readiness.recipientCount} People in ${listLabel}${sender ? ` from ${sender.address}` : ''}`
      : 'Prepare outreach email from known People',
    steps: [
      {
        kind: 'people',
        title: 'People',
        detail: existingListId
          ? `Write only to People in ${listLabel} who have an email address and are not marked do-not-contact. Suppressed, already-emailed and already-pending People are skipped.`
          : 'Resolve the supplied People input without inventing identities.',
        externalEffect: false
      },
      {
        kind: 'sender',
        title: 'Sender',
        detail: sender
          ? `Send from ${sender.address}. SPF, DKIM and DMARC for its domain must pass.`
          : 'Connect exactly one Gmail, Microsoft 365 or Zoho Mail mailbox to send from.',
        externalEffect: false
      },
      {
        kind: 'approval',
        title: 'Emails ready for review',
        detail:
          'Prepare one first-touch email per Person. Each waits for your approval of its exact text. Preparing sends nothing.',
        externalEffect: false
      },
      {
        kind: 'send',
        title: 'Send after approval',
        detail:
          sender?.unsubscribeMode === 'footer_and_reply'
            ? `Each approved email leaves from ${sender.address} through Zoho Mail, at most ${ZOHO_OUTREACH_DAILY_CAP} a day, and ends with your footer asking the recipient to reply "unsubscribe" to opt out.`
            : 'Each approved email leaves from the approved mailbox with a one-click unsubscribe link.',
        externalEffect: true
      }
    ],
    blockers,
    defaults: {
      channel: 'email',
      leadListId: existingListId,
      connectionId: sender?.connectionId ?? null,
      senderAddress: sender?.address ?? null,
      unsubscribeMode: sender?.unsubscribeMode ?? null,
      recipientCount: readiness.recipientCount,
      warnings: readiness.warnings,
      prepareSupported: blockers.length === 0 && Boolean(existingListId && sender)
    },
    consequences: {
      createsInternalState: true,
      externalWrites: false,
      approvalRequired: true
    },
    next: { kind: 'review_email_approvals', href: '/ledger' }
  });
}

async function accountPlan(db: Db, workspaceId: string, intent: GtmIntent): Promise<GtmPlan> {
  const blockers: GtmPlanBlocker[] = [];
  const objective = intent.objective;
  const domains = intent.audience?.domains ?? [];

  if (objective === 'watch_accounts') {
    if (domains.length === 0) {
      blockers.push({
        code: 'watch_domains_required',
        message:
          'Add the specific domains you want Trevra to watch. Free-text discovery stays on Research until a persistable source is selected.',
        actionHref: '/research'
      });
    }
  } else if (!hasAudience(intent)) {
    blockers.push({
      code: 'audience_required',
      message: 'Describe the accounts you want Trevra to work on.',
      actionHref: '/research'
    });
  }

  let inactiveDomains: string[] = [];
  if (objective === 'watch_accounts' && domains.length > 0) {
    const rows = await db
      .prepare(
        `SELECT LOWER(domain) AS domain,status
         FROM accounts
         WHERE workspace_id=? AND LOWER(domain)=ANY(?::text[])
           AND status<>'active'
         ORDER BY LOWER(domain) ASC`
      )
      .all<{ domain: string; status: string }>(workspaceId, domains);
    inactiveDomains = rows.map((row) => row.domain);
    if (inactiveDomains.length > 0) {
      blockers.push({
        code: 'watch_inactive_accounts',
        message: `${inactiveDomains.length} named ${inactiveDomains.length === 1 ? 'account is' : 'accounts are'} marked not-a-fit or archived. Reactivate ${inactiveDomains.length === 1 ? 'it' : 'them'} in Research before watching.`,
        actionHref: '/research'
      });
    }
  }

  const quantity = intent.audience?.quantity ?? 25;
  const audience = audienceDescription(intent);
  const common = {
    blockers,
    defaults: {
      quantity,
      evidenceRequired: true,
      prepareSupported: false
    },
    consequences: {
      createsInternalState: true,
      externalWrites: false,
      approvalRequired: false
    },
    next: { kind: 'open_research', href: '/research' }
  } as const;

  if (objective === 'find_accounts') {
    return finalizePlan({
      objective,
      intent,
      summary: `Find up to ${quantity} accounts matching ${audience}`,
      steps: [
        {
          kind: 'find',
          title: 'Find',
          detail: `Discover accounts matching ${audience}.`,
          externalEffect: false
        },
        {
          kind: 'evidence',
          title: 'Evidence',
          detail: 'Preserve source-backed evidence and provenance for every account.',
          externalEffect: false
        },
        {
          kind: 'prioritize',
          title: 'Prioritize',
          detail: 'Score the resulting accounts using Trevra GTM signals.',
          externalEffect: false
        }
      ],
      ...common
    });
  }

  if (objective === 'research_accounts') {
    return finalizePlan({
      objective,
      intent,
      summary: `Research accounts matching ${audience}`,
      steps: [
        {
          kind: 'research',
          title: 'Research',
          detail: 'Collect current website, hiring, positioning and configured source evidence.',
          externalEffect: false
        },
        {
          kind: 'signals',
          title: 'Signals',
          detail: 'Normalize only GTM-relevant evidence into account signals.',
          externalEffect: false
        }
      ],
      ...common
    });
  }

  const named = domains.length;
  return finalizePlan({
    objective: 'watch_accounts',
    intent,
    summary:
      named > 0
        ? `Watch ${named} named ${named === 1 ? 'account' : 'accounts'} for material GTM changes`
        : 'Watch named accounts for material GTM changes',
    steps: [
      {
        kind: 'accounts',
        title: 'Accounts',
        detail:
          named > 0
            ? `Ensure ${named} named ${named === 1 ? 'domain is' : 'domains are'} in the workspace without reactivating excluded accounts.`
            : 'Resolve explicit account domains without inventing company identities.',
        externalEffect: false
      },
      {
        kind: 'watch',
        title: 'Watch',
        detail:
          'Make active accounts due for Trevra’s existing paced observation sweep; no burst crawler or second scheduler is created.',
        externalEffect: false
      },
      {
        kind: 'attention',
        title: 'Surface changes',
        detail:
          'Store source-backed changes, rescore them, and promote meaningful changes into Today.',
        externalEffect: false
      }
    ],
    ...common,
    defaults: {
      ...common.defaults,
      domains,
      inactiveDomains,
      recurring: intent.timing?.recurring ?? true,
      prepareSupported: blockers.length === 0 && domains.length > 0
    },
    next: { kind: 'review_accounts', href: '/research' }
  });
}

function captureInboundPlan(intent: GtmIntent, actorRole: 'owner' | 'member'): GtmPlan {
  const blockers: GtmPlanBlocker[] = [];
  if (actorRole !== 'owner') {
    blockers.push({
      code: 'capture_owner_required',
      message: 'Only workspace owners can create a lead capture source.',
      actionHref: '/setup/capture'
    });
  }
  if (!secretsConfigured()) {
    blockers.push({
      code: 'capture_secrets_unavailable',
      message:
        'This deployment cannot create signed capture sources until secret encryption is configured.',
      actionHref: '/setup/capture'
    });
  }
  const sourceName = intent.capture?.name?.trim() || 'Website';
  const sourceKind: CaptureSourceKind = intent.capture?.kind ?? 'website';
  return finalizePlan({
    objective: 'capture_inbound',
    intent,
    summary: `Create a signed ${sourceKind} source named ${sourceName}`,
    steps: [
      {
        kind: 'capture_source',
        title: 'Capture source',
        detail: `Create the workspace-bound signed GTM source “${sourceName}”.`,
        externalEffect: false
      },
      {
        kind: 'person',
        title: 'Person',
        detail:
          'Resolve deterministic identity into canonical People without requiring an Account.',
        externalEffect: false
      },
      {
        kind: 'submission',
        title: 'Submission',
        detail: 'Preserve each inbound form submission as immutable GTM evidence.',
        externalEffect: false
      }
    ],
    blockers,
    defaults: {
      prepareSupported: blockers.length === 0,
      signedIntake: true,
      accountOptional: true,
      sourceName,
      sourceKind
    },
    consequences: {
      createsInternalState: true,
      externalWrites: false,
      approvalRequired: false
    },
    next: { kind: 'configure_capture_source', href: '/setup/capture' }
  });
}

export async function compileGtmIntent(
  db: Db,
  workspaceId: string,
  rawIntent: unknown,
  context: { actorRole?: 'owner' | 'member' } = {}
): Promise<GtmPlan> {
  const intent = normalizeIntent(rawIntent);
  if (intent.objective === 'prepare_outreach') return prepareOutreachPlan(db, workspaceId, intent);
  if (
    intent.objective === 'find_accounts' ||
    intent.objective === 'research_accounts' ||
    intent.objective === 'watch_accounts'
  ) {
    return accountPlan(db, workspaceId, intent);
  }
  return captureInboundPlan(intent, context.actorRole ?? 'owner');
}

export async function prepareGtmPlan(
  db: Db,
  input: {
    workspaceId: string;
    /** The caller's real actor type, recorded on the email approval runs it prepares. */
    actorType: 'user' | 'agent';
    actorUserId: string;
    actorRole: 'owner' | 'member';
    plan: unknown;
    planHash: string;
    idempotencyKey: string;
  }
): Promise<PreparedGtmPlanResult> {
  const supplied = suppliedPlanSchema.parse(input.plan);
  if (input.planHash !== supplied.planHash) {
    throw new GtmPlanError('The supplied plan hash does not match the plan.', 409);
  }

  const current = await compileGtmIntent(db, input.workspaceId, supplied.intent, {
    actorRole: input.actorRole
  });
  if (current.planHash !== supplied.planHash) {
    throw new GtmPlanError(
      'This GTM plan is stale because workspace state changed. Re-plan before preparing.',
      409
    );
  }
  if (current.blockers.length > 0) {
    const first = current.blockers[0]!;
    throw new GtmPlanError(first.message, first.code === 'capture_owner_required' ? 403 : 409);
  }

  if (current.objective === 'capture_inbound') {
    const sourceName =
      typeof current.defaults.sourceName === 'string' ? current.defaults.sourceName : 'Website';
    const sourceKind = CAPTURE_SOURCE_KINDS.includes(
      current.defaults.sourceKind as CaptureSourceKind
    )
      ? (current.defaults.sourceKind as CaptureSourceKind)
      : 'website';
    const result = await createCaptureSource(db, {
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      name: sourceName,
      kind: sourceKind,
      preparationKey: input.idempotencyKey,
      preparationHash: current.planHash
    });
    return {
      status: 'prepared',
      objective: 'capture_inbound',
      artifacts: { captureSourceId: result.source.id },
      next: { kind: 'configure_capture_source', href: '/setup/capture' },
      result
    };
  }

  if (current.objective === 'watch_accounts') {
    return prepareWatchAccounts(db, {
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      idempotencyKey: input.idempotencyKey,
      plan: current
    });
  }

  if (current.objective !== 'prepare_outreach') {
    throw new GtmPlanError(
      'This objective is inspectable but is not yet composed through the generic prepare boundary.',
      409
    );
  }

  if (current.defaults.channel === 'email') {
    const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
    const leadListId = text(current.defaults.leadListId);
    const connectionId = text(current.defaults.connectionId);
    const senderAddress = text(current.defaults.senderAddress);
    if (!leadListId || !connectionId || !senderAddress) {
      throw new GtmPlanError('This email plan is missing a People list or sending mailbox.', 409);
    }
    try {
      const result = await prepareEmailOutreach(db, {
        workspaceId: input.workspaceId,
        actorType: input.actorType,
        actorId: input.actorUserId,
        idempotencyKey: input.idempotencyKey,
        planHash: current.planHash,
        leadListId,
        connectionId,
        senderAddress
      });
      return {
        status: 'prepared',
        objective: 'prepare_outreach',
        channel: 'email',
        artifacts: { runIds: result.prepared.map((item) => item.runId) },
        next: { kind: 'review_email_approvals', href: '/ledger' },
        result
      };
    } catch (error) {
      if (error instanceof EmailOutreachError) throw new GtmPlanError(error.message, error.status);
      throw error;
    }
  }

  const existingLeadListId = current.intent.people?.existingListId;
  const senderKey =
    typeof current.defaults.senderKey === 'string' ? current.defaults.senderKey : null;
  if (!existingLeadListId || !senderKey) {
    throw new GtmPlanError(
      'This outreach plan is missing a deterministic People list or sender.',
      409
    );
  }
  const result = await prepareOutreach(db, {
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    idempotencyKey: input.idempotencyKey,
    senderKey,
    existingLeadListId,
    name: 'Prepared outreach'
  });
  return {
    status: 'prepared',
    objective: 'prepare_outreach',
    channel: 'linkedin',
    artifacts: result.artifacts,
    next: result.next,
    result
  };
}
