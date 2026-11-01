import { createHash } from 'node:crypto';
import type { Db } from '../db.js';
import { id } from '../db.js';
import { createLeadList, getLeadList, importLeadCsv } from '../linkedin/lead-lists.js';
import { createManagedCampaign, getManagedCampaign } from '../linkedin/managed-campaigns.js';
import { listSeats } from '../linkedin/seats.js';
import {
  getWorkflow,
  saveWorkflow,
  workflowStepsSchema,
  type LinkedInWorkflow,
  type WorkflowStep
} from '../linkedin/workflows.js';

export const DEFAULT_LINKEDIN_OUTREACH_WORKFLOW_NAME = 'Trevra default — LinkedIn outreach v1';

/**
 * A deliberately conservative first-campaign sequence.
 *
 * The campaign remains DRAFT after preparation. Starting it is the operator's
 * separate consequential decision, and every LinkedIn guard/pacing rule still
 * evaluates the resulting actions at execution time.
 */
export const DEFAULT_LINKEDIN_OUTREACH_STEPS: WorkflowStep[] = workflowStepsSchema.parse([
  {
    id: 'view',
    action: 'profile_view',
    delayBefore: { amount: 0, unit: 'hours' },
    config: {}
  },
  {
    id: 'invite',
    action: 'connection_request',
    delayBefore: { amount: 1, unit: 'hours' },
    config: { message: null }
  },
  {
    id: 'wait-after-invite',
    action: 'wait',
    delayBefore: { amount: 0, unit: 'hours' },
    config: { duration: { amount: 3, unit: 'days' } }
  },
  {
    id: 'message',
    action: 'message',
    delayBefore: { amount: 0, unit: 'hours' },
    config: {
      requiresAcceptedConnection: true,
      variants: [
        {
          id: 'default',
          body: 'Hi {{first_name}}, thanks for connecting. I wanted to learn more about what you are working on at {{company}}.',
          weight: 100
        }
      ]
    }
  },
  {
    id: 'wait-before-follow-up',
    action: 'wait',
    delayBefore: { amount: 0, unit: 'hours' },
    config: { duration: { amount: 7, unit: 'days' } }
  },
  {
    id: 'follow-up',
    action: 'message',
    delayBefore: { amount: 0, unit: 'hours' },
    config: {
      requiresAcceptedConnection: true,
      variants: [
        {
          id: 'default',
          body: 'Hi {{first_name}}, following up in case this got buried. Happy to leave it here if the timing is not right.',
          weight: 100
        }
      ]
    }
  },
  {
    id: 'done',
    action: 'end',
    delayBefore: { amount: 0, unit: 'hours' },
    config: { outcome: 'completed' }
  }
]);

export interface PrepareOutreachInput {
  workspaceId: string;
  actorUserId: string;
  idempotencyKey: string;
  name?: string;
  senderKey?: string;
  existingLeadListId?: string;
  uploadedPeopleCsv?: string;
  /**
   * A sequence to use instead of the default workflow. Saved once as the
   * actor's personal workflow, named after this preparation.
   */
  steps?: unknown;
  /** The Agent preparing this campaign. Marks it agent-prepared (migration 169). */
  preparedByAgentId?: string;
}

export interface PreparedOutreachResult {
  status: 'prepared';
  duplicate: boolean;
  artifacts: {
    leadListId: string;
    workflowId: string;
    campaignId: string;
  };
  campaign: {
    id: string;
    name: string;
    status: string;
    enrolled: number;
    excluded: number;
    skippedAlreadyActive: number;
  };
  next: {
    kind: 'review_campaign';
    href: string;
  };
}

interface PreparationRow {
  id: string;
  workspace_id: string;
  idempotency_key: string;
  request_hash: string;
  status: string;
  sender_key: string | null;
  lead_list_id: string | null;
  workflow_id: string | null;
  campaign_id: string | null;
  last_error: string | null;
}

export class PrepareOutreachError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

function normalizeInput(input: PrepareOutreachInput) {
  const idempotencyKey = input.idempotencyKey.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(idempotencyKey)) {
    throw new PrepareOutreachError('A valid idempotency key is required.', 400);
  }
  const existingLeadListId = input.existingLeadListId?.trim() || null;
  const uploadedPeopleCsv = input.uploadedPeopleCsv?.trim() || null;
  if (Boolean(existingLeadListId) === Boolean(uploadedPeopleCsv)) {
    throw new PrepareOutreachError(
      'Choose exactly one people source: an existing lead list or an uploaded CSV.',
      400
    );
  }
  let steps: WorkflowStep[] | null = null;
  if (input.steps !== undefined) {
    const parsed = workflowStepsSchema.safeParse(input.steps);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.length ? ` (steps.${issue.path.join('.')})` : '';
      throw new PrepareOutreachError(
        `The sequence is not valid: ${issue?.message ?? 'invalid steps'}${where}`,
        400
      );
    }
    steps = parsed.data;
  }
  const preparedByAgentId = input.preparedByAgentId?.trim() || null;
  if (uploadedPeopleCsv && Buffer.byteLength(uploadedPeopleCsv, 'utf8') > 2_000_000) {
    throw new PrepareOutreachError('People CSV is too large; keep it under 2 MB.', 413);
  }
  const name = input.name?.trim() || 'Prepared outreach';
  if (name.length > 160) throw new PrepareOutreachError('Campaign name is too long.', 400);
  return {
    idempotencyKey,
    existingLeadListId,
    uploadedPeopleCsv,
    steps,
    preparedByAgentId,
    senderKey: input.senderKey?.trim() || null,
    name
  };
}

function requestHash(input: ReturnType<typeof normalizeInput>): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        name: input.name,
        senderKey: input.senderKey,
        existingLeadListId: input.existingLeadListId,
        uploadedPeopleCsv: input.uploadedPeopleCsv,
        // Added only when present, so a key stored before these fields existed
        // still hashes the same and its retry is not refused as a new request.
        ...(input.steps ? { steps: input.steps } : {}),
        ...(input.preparedByAgentId ? { preparedByAgentId: input.preparedByAgentId } : {})
      })
    )
    .digest('hex');
}

/**
 * The personal workflow holding a preparation's custom sequence. Its name
 * carries the request hash, so a retry after a crash finds the one it saved
 * instead of colliding with it on the unique workflow name.
 */
async function ensurePreparedWorkflow(
  db: Db,
  input: { workspaceId: string; ownerUserId: string; name: string; steps: WorkflowStep[] },
  now: Date
): Promise<LinkedInWorkflow> {
  const existing = await db
    .prepare(
      `SELECT id,owner_user_id FROM linkedin_workflows
       WHERE workspace_id=? AND LOWER(name)=LOWER(?) LIMIT 1`
    )
    .get<{ id: string; owner_user_id: string | null }>(input.workspaceId, input.name);
  if (existing) {
    if (existing.owner_user_id !== input.ownerUserId)
      throw new PrepareOutreachError(
        'A workflow with this preparation name already exists. Use a different campaign name.',
        409
      );
    const workflow = await getWorkflow(db, input.workspaceId, existing.id);
    if (!workflow) throw new Error('Prepared outreach workflow disappeared.');
    return workflow;
  }
  return saveWorkflow(
    db,
    {
      workspaceId: input.workspaceId,
      name: input.name,
      steps: input.steps,
      scope: 'personal',
      ownerUserId: input.ownerUserId
    },
    now
  );
}

async function ensureDefaultWorkflow(
  db: Db,
  workspaceId: string,
  now: Date
): Promise<LinkedInWorkflow> {
  const existing = await db
    .prepare(
      `SELECT id FROM linkedin_workflows
       WHERE workspace_id=? AND LOWER(name)=LOWER(?)
       ORDER BY created_at ASC LIMIT 1`
    )
    .get<{ id: string }>(workspaceId, DEFAULT_LINKEDIN_OUTREACH_WORKFLOW_NAME);
  if (existing) {
    const workflow = await getWorkflow(db, workspaceId, existing.id);
    if (!workflow) throw new Error('Default outreach workflow disappeared.');
    return workflow;
  }

  const workflowId = id('liwf');
  const timestamp = now.toISOString();
  await db
    .prepare(
      `INSERT INTO linkedin_workflows
       (id,workspace_id,name,scope,owner_user_id,steps_json,version,created_at,updated_at)
       VALUES (?,? ,?,'workspace',NULL,?::jsonb,1,?,?)
       ON CONFLICT DO NOTHING`
    )
    .run(
      workflowId,
      workspaceId,
      DEFAULT_LINKEDIN_OUTREACH_WORKFLOW_NAME,
      JSON.stringify(DEFAULT_LINKEDIN_OUTREACH_STEPS),
      timestamp,
      timestamp
    );

  const row = await db
    .prepare(
      `SELECT id FROM linkedin_workflows
       WHERE workspace_id=? AND LOWER(name)=LOWER(?)
       ORDER BY created_at ASC LIMIT 1`
    )
    .get<{ id: string }>(workspaceId, DEFAULT_LINKEDIN_OUTREACH_WORKFLOW_NAME);
  if (!row) throw new Error('Default outreach workflow could not be created.');
  const workflow = await getWorkflow(db, workspaceId, row.id);
  if (!workflow) throw new Error('Default outreach workflow could not be loaded.');
  return workflow;
}

async function resolveSender(
  db: Db,
  workspaceId: string,
  requested: string | null
): Promise<string> {
  const seats = await listSeats(db, workspaceId);
  if (requested) {
    if (!seats.some((seat) => seat.seatKey === requested)) {
      throw new PrepareOutreachError(`LinkedIn account '${requested}' is not configured.`, 400);
    }
    return requested;
  }
  if (seats.length === 0) {
    throw new PrepareOutreachError(
      'Connect the LinkedIn account you want to use before preparing outreach.',
      400
    );
  }
  if (seats.length > 1) {
    throw new PrepareOutreachError('Choose which LinkedIn account should send this outreach.', 400);
  }
  return seats[0]!.seatKey;
}

async function loadPreparation(
  db: Db,
  workspaceId: string,
  idempotencyKey: string
): Promise<PreparationRow | undefined> {
  return db
    .prepare(
      'SELECT * FROM outreach_preparations WHERE workspace_id=? AND idempotency_key=? LIMIT 1'
    )
    .get<PreparationRow>(workspaceId, idempotencyKey);
}

async function preparedResult(
  db: Db,
  row: PreparationRow,
  duplicate: boolean
): Promise<PreparedOutreachResult | null> {
  if (!row.lead_list_id || !row.workflow_id || !row.campaign_id) return null;
  const campaign = await getManagedCampaign(db, row.workspace_id, row.campaign_id);
  if (!campaign) {
    throw new PrepareOutreachError(
      'This preparation key already refers to a campaign that no longer exists. Use a new idempotency key.',
      409
    );
  }
  const counts = await db
    .prepare(
      `SELECT
         COUNT(*) FILTER (WHERE status<>'excluded')::int AS enrolled,
         COUNT(*) FILTER (WHERE status='excluded')::int AS excluded,
         COUNT(*) FILTER (WHERE exclusion_reason='Already in another live campaign')::int AS skipped
       FROM linkedin_campaign_members WHERE workspace_id=? AND campaign_id=?`
    )
    .get<{ enrolled: number; excluded: number; skipped: number }>(row.workspace_id, campaign.id);
  return {
    status: 'prepared',
    duplicate,
    artifacts: {
      leadListId: row.lead_list_id,
      workflowId: row.workflow_id,
      campaignId: campaign.id
    },
    campaign: {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      enrolled: Number(counts?.enrolled ?? 0),
      excluded: Number(counts?.excluded ?? 0),
      skippedAlreadyActive: Number(counts?.skipped ?? 0)
    },
    next: { kind: 'review_campaign', href: `/outreach/campaign/${encodeURIComponent(campaign.id)}` }
  };
}

export async function prepareOutreach(
  db: Db,
  rawInput: PrepareOutreachInput,
  now: Date = new Date()
): Promise<PreparedOutreachResult> {
  const input = normalizeInput(rawInput);
  const hash = requestHash(input);
  const timestamp = now.toISOString();

  const preparationId = id('oprep');
  const inserted = await db
    .prepare(
      `INSERT INTO outreach_preparations
       (id,workspace_id,idempotency_key,request_hash,status,created_at,updated_at)
       VALUES (?,?,?,?,'preparing',?,?)
       ON CONFLICT (workspace_id,idempotency_key) DO NOTHING
       RETURNING id`
    )
    .get<{ id: string }>(
      preparationId,
      rawInput.workspaceId,
      input.idempotencyKey,
      hash,
      timestamp,
      timestamp
    );

  let row = await loadPreparation(db, rawInput.workspaceId, input.idempotencyKey);
  if (!row) throw new Error('Outreach preparation could not be claimed.');
  if (row.request_hash !== hash) {
    throw new PrepareOutreachError(
      'This idempotency key was already used for a different outreach preparation.',
      409
    );
  }
  if (!inserted && row.status === 'prepared') {
    const duplicate = await preparedResult(db, row, true);
    if (duplicate) return duplicate;
  }

  try {
    let senderKey = row.sender_key;
    if (!senderKey) {
      senderKey = await resolveSender(db, rawInput.workspaceId, input.senderKey);
      await db
        .prepare(
          `UPDATE outreach_preparations SET sender_key=?,status='preparing',last_error=NULL,updated_at=?
           WHERE id=? AND workspace_id=?`
        )
        .run(senderKey, timestamp, row.id, rawInput.workspaceId);
    }

    let leadListId = row.lead_list_id;
    if (!leadListId && input.existingLeadListId) {
      const list = await getLeadList(db, rawInput.workspaceId, input.existingLeadListId, senderKey);
      if (!list)
        throw new PrepareOutreachError('Lead list not found for this LinkedIn account.', 400);
      leadListId = list.id;
      await db
        .prepare('UPDATE outreach_preparations SET lead_list_id=?,updated_at=? WHERE id=?')
        .run(leadListId, timestamp, row.id);
    }

    if (!leadListId && input.uploadedPeopleCsv) {
      const sourceRef = `outreach-preparation:${row.id}`;
      // A retry after a crash between creating the list and recording it finds
      // the same list instead of failing on the unique list name.
      const recovered = await db
        .prepare('SELECT id FROM linkedin_lead_lists WHERE workspace_id=? AND source_ref=? LIMIT 1')
        .get<{ id: string }>(rawInput.workspaceId, sourceRef);
      const listId =
        recovered?.id ??
        (
          await createLeadList(
            db,
            {
              workspaceId: rawInput.workspaceId,
              seatKey: senderKey,
              name: `${input.name} people ${hash.slice(0, 8)}`,
              sourceKind: 'csv',
              sourceRef
            },
            now
          )
        ).id;
      await importLeadCsv(
        db,
        {
          workspaceId: rawInput.workspaceId,
          seatKey: senderKey,
          listId,
          csv: input.uploadedPeopleCsv
        },
        now
      );
      // Judged on the list's membership, not this call's counts: a retry's
      // import finds everyone already there. The preparation records the list
      // only once it holds someone, so a failed import is retried on the next
      // call, never turned into a campaign with nobody in it.
      const members = await db
        .prepare(
          'SELECT COUNT(*)::int AS total FROM linkedin_lead_list_members WHERE workspace_id=? AND list_id=?'
        )
        .get<{ total: number }>(rawInput.workspaceId, listId);
      if (!members?.total) {
        throw new PrepareOutreachError('The CSV did not contain any campaign-usable people.', 400);
      }
      leadListId = listId;
      await db
        .prepare('UPDATE outreach_preparations SET lead_list_id=?,updated_at=? WHERE id=?')
        .run(leadListId, timestamp, row.id);
    }

    if (!leadListId) throw new Error('Outreach preparation has no lead list.');

    let workflowId = row.workflow_id;
    if (!workflowId) {
      const workflow = input.steps
        ? await ensurePreparedWorkflow(
            db,
            {
              workspaceId: rawInput.workspaceId,
              ownerUserId: rawInput.actorUserId,
              name: `${input.name} sequence ${hash.slice(0, 8)}`,
              steps: input.steps
            },
            now
          )
        : await ensureDefaultWorkflow(db, rawInput.workspaceId, now);
      workflowId = workflow.id;
      await db
        .prepare('UPDATE outreach_preparations SET workflow_id=?,updated_at=? WHERE id=?')
        .run(workflowId, timestamp, row.id);
    }

    let campaignId = row.campaign_id;
    if (!campaignId) {
      const recovered = await db
        .prepare(
          'SELECT id FROM linkedin_campaigns WHERE workspace_id=? AND preparation_id=? LIMIT 1'
        )
        .get<{ id: string }>(rawInput.workspaceId, row.id);
      if (recovered) campaignId = recovered.id;
    }

    if (!campaignId) {
      const created = await createManagedCampaign(
        db,
        {
          workspaceId: rawInput.workspaceId,
          ownerUserId: rawInput.actorUserId,
          name: input.name,
          seatKey: senderKey,
          leadListId,
          workflowId,
          preparationId: row.id,
          preparedByAgentId: input.preparedByAgentId
        },
        now
      );
      campaignId = created.campaign.id;
    }

    await db
      .prepare(
        `UPDATE outreach_preparations
         SET status='prepared',sender_key=?,lead_list_id=?,workflow_id=?,campaign_id=?,last_error=NULL,updated_at=?
         WHERE id=? AND workspace_id=?`
      )
      .run(senderKey, leadListId, workflowId, campaignId, timestamp, row.id, rawInput.workspaceId);

    row = (await loadPreparation(db, rawInput.workspaceId, input.idempotencyKey))!;
    const result = await preparedResult(db, row, !inserted);
    if (!result) throw new Error('Prepared outreach artifacts could not be loaded.');
    return result;
  } catch (error) {
    await db
      .prepare(
        `UPDATE outreach_preparations SET status='failed',last_error=?,updated_at=?
         WHERE id=? AND workspace_id=?`
      )
      .run(
        error instanceof Error ? error.message : String(error),
        new Date().toISOString(),
        row.id,
        rawInput.workspaceId
      );
    throw error;
  }
}
