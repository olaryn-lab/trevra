import { createHash } from 'node:crypto';
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import type { Db } from '../db.js';
import { BillingServiceError, getBillingClient, type BillingApi } from '../billing-client.js';
import {
  accountBlock,
  entitlementUsage,
  loadEntitlements,
  trialState,
  usageAgainstCapabilities,
  type EntitlementUsageLine
} from './entitlements.js';
import { RENEWAL_NOTICE_DAYS, isAnnualPlan } from './renewal.js';

type BillingRequest = Request & {
  auth?: { userId: string; workspaceId: string; role: 'owner' | 'member' };
};

const NONCE = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/);
const PLAN_CODE = z.string().trim().min(3).max(128);
const DAY_MS = 24 * 60 * 60_000;

/**
 * Idempotency key for a Billing lifecycle call, derived from the workspace, the
 * action, its target plan and the client's per-intent nonce. A double click or
 * a retried request reuses the nonce and so the key; Billing then returns the
 * first result instead of acting twice. The workspace is part of the hash, so
 * one workspace's nonce can never collide with another's.
 */
export function billingIdempotencyKey(
  workspaceId: string,
  action: 'checkout' | 'change' | 'cancel' | 'resume',
  target: string,
  nonce: string
): string {
  const digest = createHash('sha256')
    .update(`${workspaceId}|${action}|${target}|${nonce}`, 'utf8')
    .digest('hex');
  return `trv.${action}.${digest.slice(0, 40)}`;
}

function sendBillingError(res: Response, next: NextFunction, error: unknown) {
  if (error instanceof BillingServiceError) {
    const clientError = error.status !== null && error.status >= 400 && error.status < 500;
    res
      .status(clientError ? 400 : 503)
      .json({ error: clientError ? error.message : 'Billing service unavailable' });
    return;
  }
  next(error);
}

function appOrigin(req: Request): string {
  return (
    process.env.BETTER_AUTH_URL?.trim().replace(/\/$/, '') || `${req.protocol}://${req.get('host')}`
  );
}

async function workspaceRow(db: Db, workspaceId: string) {
  return db
    .prepare('SELECT id,name FROM workspaces WHERE id=?')
    .get<{ id: string; name: string }>(workspaceId);
}

/** Which of today's resources would exceed `planCode`'s capabilities. Best effort. */
async function overLimitFor(
  db: Db,
  client: BillingApi,
  workspaceId: string,
  planCode: string
): Promise<EntitlementUsageLine[] | null> {
  try {
    const plan = (await client.plans()).find((candidate) => candidate.plan_code === planCode);
    if (!plan) return null;
    const lines = await entitlementUsage(db, workspaceId, plan.capabilities ?? {});
    return usageAgainstCapabilities(lines, plan.capabilities ?? {}).filter((line) => line.over);
  } catch {
    return null;
  }
}

/**
 * TRV-057 billing API. Reads are open to every member; every call that can
 * change what the workspace pays is owner-only. Plan changes, cancellation and
 * resumption are Billing's own operations (upgrade immediate with proration,
 * downgrade and cancel at period end); Trevra never deletes anything when a
 * plan shrinks -- the entitlement gate blocks new expansion instead.
 */
export function mountBillingRoutes(
  app: Express,
  db: Db,
  ownerOnly: (act: string) => RequestHandler
): void {
  app.get('/api/billing', async (req: BillingRequest, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const client = getBillingClient();
      if (!client) return res.json({ enabled: false });
      const workspaceId = req.auth!.workspaceId;
      if (!(await workspaceRow(db, workspaceId)))
        return res.status(404).json({ error: 'Workspace not found' });
      const view = await loadEntitlements(db, workspaceId, { client, purpose: 'read' });
      if (view.mode !== 'metered' || !view.snapshot)
        return res.status(503).json({ error: 'Billing service unavailable' });
      const snapshot = view.snapshot;
      const subscription = snapshot.subscription;
      const end = subscription.current_period_end
        ? new Date(subscription.current_period_end)
        : null;
      const annual = isAnnualPlan(subscription.plan_code);
      const renews =
        end !== null &&
        !Number.isNaN(end.getTime()) &&
        ['active', 'trialing', 'past_due'].includes(subscription.status) &&
        !subscription.cancel_at_period_end;
      res.json({
        enabled: true,
        // TREVRA_BILLING_ENFORCEMENT: limits block only under `enforce`.
        enforcement: view.enforcement,
        canManage: req.auth!.role === 'owner',
        customer: snapshot.customer,
        subscription,
        credits: snapshot.credits,
        entitlements: snapshot.entitlements,
        state: {
          fetchedAt: view.fetchedAt?.toISOString() ?? null,
          stale: view.stale,
          withinGrace: view.withinGrace,
          graceEndsAt: view.graceEndsAt?.toISOString() ?? null
        },
        trial: trialState(snapshot, view.now),
        renewal: {
          renewsOn: renews && end ? end.toISOString().slice(0, 10) : null,
          endsOn: subscription.cancel_at_period_end && end ? end.toISOString().slice(0, 10) : null,
          annual,
          cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
          scheduledPlanCode: subscription.scheduled_plan_code ?? null,
          noticeDays: RENEWAL_NOTICE_DAYS,
          noticeDue:
            annual &&
            renews &&
            end !== null &&
            end.getTime() - view.now.getTime() <= RENEWAL_NOTICE_DAYS * DAY_MS
        },
        usage: await entitlementUsage(db, workspaceId, snapshot.entitlements.features, view.now),
        expansionBlock: accountBlock(view)
      });
    } catch (error) {
      sendBillingError(res, next, error);
    }
  });

  app.get('/api/billing/plans', async (_req: BillingRequest, res, next) => {
    try {
      const client = getBillingClient();
      res.setHeader('Cache-Control', 'no-store');
      if (!client) return res.json({ enabled: false, plans: [] });
      res.json({ enabled: true, plans: await client.plans() });
    } catch (error) {
      sendBillingError(res, next, error);
    }
  });

  app.post(
    '/api/billing/checkout',
    ownerOnly('change the workspace billing plan'),
    async (req: BillingRequest, res, next) => {
      try {
        res.setHeader('Cache-Control', 'no-store');
        const parsed = z.object({ planCode: PLAN_CODE, nonce: NONCE }).strict().safeParse(req.body);
        if (!parsed.success)
          return res.status(400).json({ error: 'A valid planCode and nonce are required' });
        const client = getBillingClient();
        if (!client) return res.status(503).json({ error: 'Billing is not configured' });
        const workspace = await workspaceRow(db, req.auth!.workspaceId);
        if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
        await client.ensureWorkspaceCustomer({
          workspaceId: workspace.id,
          name: workspace.name,
          currency: 'USD'
        });
        const origin = appOrigin(req);
        const checkout = await client.startPlan({
          workspaceId: workspace.id,
          planCode: parsed.data.planCode,
          successUrl: `${origin}/setup/billing?checkout=success`,
          cancelUrl: `${origin}/setup/billing?checkout=cancelled`,
          idempotencyKey: billingIdempotencyKey(
            workspace.id,
            'checkout',
            parsed.data.planCode,
            parsed.data.nonce
          )
        });
        res.json(checkout);
      } catch (error) {
        sendBillingError(res, next, error);
      }
    }
  );

  app.post(
    '/api/billing/preview',
    ownerOnly('preview a billing plan change'),
    async (req: BillingRequest, res, next) => {
      try {
        res.setHeader('Cache-Control', 'no-store');
        const parsed = z.object({ planCode: PLAN_CODE }).strict().safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: 'A valid planCode is required' });
        const client = getBillingClient();
        if (!client) return res.status(503).json({ error: 'Billing is not configured' });
        const workspaceId = req.auth!.workspaceId;
        const [preview, overLimit] = await Promise.all([
          client.previewPlanChange({ workspaceId, planCode: parsed.data.planCode }),
          overLimitFor(db, client, workspaceId, parsed.data.planCode)
        ]);
        res.json({ preview, overLimit });
      } catch (error) {
        sendBillingError(res, next, error);
      }
    }
  );

  app.post(
    '/api/billing/change',
    ownerOnly('change the workspace billing plan'),
    async (req: BillingRequest, res, next) => {
      try {
        res.setHeader('Cache-Control', 'no-store');
        const parsed = z.object({ planCode: PLAN_CODE, nonce: NONCE }).strict().safeParse(req.body);
        if (!parsed.success)
          return res.status(400).json({ error: 'A valid planCode and nonce are required' });
        const client = getBillingClient();
        if (!client) return res.status(503).json({ error: 'Billing is not configured' });
        const workspace = await workspaceRow(db, req.auth!.workspaceId);
        if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
        await client.ensureWorkspaceCustomer({
          workspaceId: workspace.id,
          name: workspace.name,
          currency: 'USD'
        });
        const origin = appOrigin(req);
        const result = await client.changePlan({
          workspaceId: workspace.id,
          planCode: parsed.data.planCode,
          successUrl: `${origin}/setup/billing?checkout=success`,
          cancelUrl: `${origin}/setup/billing?checkout=cancelled`,
          idempotencyKey: billingIdempotencyKey(
            workspace.id,
            'change',
            parsed.data.planCode,
            parsed.data.nonce
          )
        });
        const overLimit = await overLimitFor(db, client, workspace.id, parsed.data.planCode);
        await loadEntitlements(db, workspace.id, { client, refresh: 'force', purpose: 'read' });
        res.json({ result, overLimit });
      } catch (error) {
        sendBillingError(res, next, error);
      }
    }
  );

  for (const action of ['cancel', 'resume'] as const) {
    app.post(
      `/api/billing/${action}`,
      ownerOnly(action === 'cancel' ? 'cancel the workspace plan' : 'resume the workspace plan'),
      async (req: BillingRequest, res, next) => {
        try {
          res.setHeader('Cache-Control', 'no-store');
          const parsed = z.object({ nonce: NONCE }).strict().safeParse(req.body);
          if (!parsed.success) return res.status(400).json({ error: 'A valid nonce is required' });
          const client = getBillingClient();
          if (!client) return res.status(503).json({ error: 'Billing is not configured' });
          const workspaceId = req.auth!.workspaceId;
          const idempotencyKey = billingIdempotencyKey(
            workspaceId,
            action,
            'subscription',
            parsed.data.nonce
          );
          const result =
            action === 'cancel'
              ? await client.cancelSubscription({ workspaceId, idempotencyKey })
              : await client.resumeSubscription({ workspaceId, idempotencyKey });
          await loadEntitlements(db, workspaceId, { client, refresh: 'force', purpose: 'read' });
          res.json({ result });
        } catch (error) {
          sendBillingError(res, next, error);
        }
      }
    );
  }
}
