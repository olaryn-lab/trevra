import type { Db } from '../db.js';
import { getBillingClient, type BillingApi } from '../billing-client.js';
import {
  billingEnforcementMode,
  loadEntitlements,
  type BillingEnforcementMode
} from './entitlements.js';
import {
  USAGE_LOOKBACK_MS,
  armUsageMetering,
  disarmUsageMetering,
  enqueueBillableUsage,
  pruneBillingUsage,
  reportPendingUsage
} from './usage.js';
import { pruneRenewalNotices, sendAnnualRenewalNotices } from './renewal.js';

/**
 * One worker pass of TRV-057 billing upkeep. Billing pushes nothing to
 * products, so Trevra polls: refresh aging snapshots, start metering for
 * workspaces doing billable work, report usage, send renewal notices, prune.
 * Every step is isolated, so a Billing outage in one never skips the others.
 * With Billing unconfigured it does nothing.
 *
 * Usage metering (start, enqueue, report) runs only under
 * TREVRA_BILLING_ENFORCEMENT=enforce; any other mode clears the metering
 * stamps instead. Snapshot refresh, the informational annual renewal notice
 * and pruning run in every mode.
 */
const SNAPSHOT_REFRESH_AFTER_MS = 6 * 60 * 60_000;

export type BillingMaintenanceResult = {
  enabled: boolean;
  enforcement: BillingEnforcementMode;
  refreshed: number;
  started: number;
  enqueued: number;
  reported: number;
  renewalNotices: number;
  errors: string[];
};

export async function runBillingMaintenance(
  db: Db,
  options: {
    now?: Date;
    client?: BillingApi | null;
    shouldStop?: () => boolean;
    enforcement?: BillingEnforcementMode;
  } = {}
): Promise<BillingMaintenanceResult> {
  const client = options.client === undefined ? getBillingClient() : options.client;
  const enforcement = options.enforcement ?? billingEnforcementMode();
  const metering = enforcement === 'enforce';
  const result: BillingMaintenanceResult = {
    enabled: Boolean(client),
    enforcement,
    refreshed: 0,
    started: 0,
    enqueued: 0,
    reported: 0,
    renewalNotices: 0,
    errors: []
  };
  if (!client) return result;
  const now = options.now ?? new Date();
  const stop = options.shouldStop ?? (() => false);
  const step = async (name: string, run: () => Promise<void>) => {
    if (stop()) return;
    try {
      await run();
    } catch (error) {
      result.errors.push(
        `${name}: ${error instanceof Error ? error.message : 'failed'}`.slice(0, 200)
      );
    }
  };

  await step('refresh', async () => {
    const due = await db
      .prepare(
        `SELECT workspace_id FROM billing_workspace_state
         WHERE fetched_at < ? AND (last_attempt_at IS NULL OR last_attempt_at < ?)
         ORDER BY fetched_at LIMIT 20`
      )
      .all<{ workspace_id: string }>(
        new Date(now.getTime() - SNAPSHOT_REFRESH_AFTER_MS).toISOString(),
        new Date(now.getTime() - 60_000).toISOString()
      );
    for (const row of due) {
      if (stop()) return;
      const view = await loadEntitlements(db, row.workspace_id, {
        now,
        client,
        refresh: 'force',
        purpose: 'read',
        enforcement
      });
      if (view.mode === 'metered' && !view.stale) result.refreshed += 1;
    }
  });

  if (!metering) {
    // Observe/off: nothing is metered, and a later switch to enforce starts
    // from that moment rather than from an earlier enforce period.
    await step('metering', async () => {
      await disarmUsageMetering(db, now);
    });
  }

  // Workspaces already doing billable work get a state row here, and the
  // metering stamp right after; usage before that moment is never billed.
  if (metering)
    await step('start', async () => {
      const since = new Date(now.getTime() - USAGE_LOOKBACK_MS).toISOString();
      const missing = await db
        .prepare(
          `SELECT w.id FROM workspaces w
         WHERE NOT EXISTS (SELECT 1 FROM billing_workspace_state s WHERE s.workspace_id=w.id)
           AND (EXISTS (SELECT 1 FROM linkedin_campaigns c WHERE c.workspace_id=w.id AND c.status='running')
                OR EXISTS (SELECT 1 FROM domain_events e WHERE e.workspace_id=w.id
                           AND e.event_type='action.executed' AND e.occurred_at >= ?))
         ORDER BY w.id LIMIT 10`
        )
        .all<{ id: string }>(since);
      for (const row of missing) {
        if (stop()) return;
        const view = await loadEntitlements(db, row.id, {
          now,
          client,
          refresh: 'force',
          purpose: 'read',
          enforcement
        });
        if (view.mode === 'metered' && view.snapshot) result.started += 1;
      }
    });

  if (metering) {
    await step('enqueue', async () => {
      await armUsageMetering(db, now);
      result.enqueued = await enqueueBillableUsage(db, { now, mode: enforcement });
    });
    await step('report', async () => {
      result.reported = (
        await reportPendingUsage(db, { client, now, limit: 50, mode: enforcement })
      ).reported;
    });
  }
  await step('renewal', async () => {
    result.renewalNotices = (await sendAnnualRenewalNotices(db, { now })).sent;
  });
  await step('prune', async () => {
    await pruneBillingUsage(db, now);
    await pruneRenewalNotices(db, now);
  });
  return result;
}
