import 'dotenv/config';
import express from 'express';
import { openDatabase } from '../server/db.js';
import {
  createExclusiveLane,
  createLinkedInCycleHealth,
  linkedInSchedulerStatus
} from './linkedin-runtime.js';
import { createLinkedInStartupCoordinator } from './linkedin-startup.js';
import { notifyStalledLinkedInCampaigns } from '../server/linkedin/stall-monitor.js';
import { runAllAutomationCycles } from '../server/automation-service.js';
import { runReadyPlaybooks } from '../server/playbooks/engine.js';
import { runDueAgentSchedules } from '../server/agent/schedule.js';
import { dispatchOutboundWebhookDeliveries } from '../server/outbound-webhooks.js';
import { reapStaleAgentRuns } from '../server/agent/runs.js';
import { orchestrationMode } from '../server/orchestration/client.js';
import { validateEnvironment } from '../server/config.js';
import { assertHostedDataReady } from '../server/hosted-readiness.js';
import {
  closeLinkedInBrowser,
  seatConcurrencyForConfig,
  linkedInWorkerHealth,
  linkedinWorkspaceIdsForShard,
  runBounded,
  runDueLinkedInActions,
  runPendingSeatDetectRequests,
  seatRefsForShard,
  workerIdentity,
  workerShard
} from '../server/linkedin/local-worker.js';
import {
  notifyCompanionSeatAttentionEmails,
  notifyDisconnectedCompanionDevices
} from '../server/linkedin/companion.js';
import {
  runLinkedInCampaignTick,
  runLinkedInPostTick,
  runLinkedInSideTasks
} from '../server/linkedin/jobs.js';
import { hostedExecutionMode, hostedSeatFilter } from '../server/linkedin/hosted-execution.js';
import { runDueResearchSources } from '../server/research/service.js';
import { runDueBrandWatches } from '../server/watch/service.js';
import { runQueuedEnrichmentRuns } from '../server/enrichment/runs.js';
import { pruneCitationSamples } from '../server/watch/citations.js';
import { refreshDueEmailDeliverability } from '../server/email/sender-deliverability.js';
import { registerEmailComplianceProvider } from '../server/email/compliance.js';
import { senderComplianceProvider } from '../server/compliance/provider.js';

const runtime = validateEnvironment();
// READ AND VALIDATED AT STARTUP, NEVER PER TICK. A shard that is not a
// partition -- index 5 of 3, a total of 0 -- means this process serves either a
// slice nobody serves or one somebody else is already serving, and both fail
// silently as a queue that half drains. `workerShard` throws; here is where an
// operator is watching.
const linkedinShard = workerShard();
const linkedinWorkerId = workerIdentity();
const linkedinWorkerStartedAt = new Date();
let linkedinStallLastResult: {
  checkedAt: string | null;
  detected: number;
  notified: number;
  failed: number;
  lastError: string | null;
} = { checkedAt: null, detected: 0, notified: 0, failed: 0, lastError: null };
// The worker runs approved outreach sends (playbooks, Temporal) without
// createApp, so it registers the real footer provider itself; without it every
// approved outreach email is refused at send time.
registerEmailComplianceProvider(senderComplianceProvider);
const db = await openDatabase();
await assertHostedDataReady(db);
const temporalWorker =
  orchestrationMode() === 'temporal'
    ? await (await import('../server/orchestration/worker.js')).startTemporalWorker(db)
    : null;
const app = express();
app.disable('x-powered-by');
app.get('/health', async (_req, res) => {
  // THE LINKEDIN QUEUE IS PART OF "HEALTHY", and it was not reportable at all.
  // A discovery read that fails returns the same empty list as a queue with
  // nothing due, so the one failure that stops EVERY tenant's automation used
  // to look exactly like the ordinary quiet case. It does not fail the probe --
  // a worker that cannot read the LinkedIn queue is still serving playbooks,
  // schedules and projections, and restarting it would fix nothing -- but it is
  // now a fact a monitor can alert on.
  const linkedin = linkedInWorkerHealth();
  const cycles = linkedinCycleHealth.snapshot();
  const scheduler = linkedInSchedulerStatus(cycles, {
    now: new Date(),
    startedAt: linkedinWorkerStartedAt,
    intervalMs: runtime.automationIntervalMs,
    enabled: runtime.linkedinLocalWorker.enabled,
    discoveryHealthy: linkedin.discoveryHealthy
  });
  try {
    await db.prepare('SELECT 1 AS ok').get();
    res.json({
      ok: true,
      service: 'trevra-worker',
      orchestrator: orchestrationMode(),
      worker: linkedinWorkerId,
      linkedinShard: `${linkedinShard.index + 1}/${linkedinShard.total}`,
      linkedin: {
        ...linkedin,
        cycles,
        scheduler,
        browserLane: linkedInBrowserLane.snapshot(),
        stallMonitor: linkedinStallLastResult
      }
    });
  } catch {
    res.status(503).json({ ok: false, service: 'trevra-worker', linkedin });
  }
});
const server = app.listen(runtime.port, () =>
  console.log(`Trevra worker health listening on http://localhost:${runtime.port}`)
);

// SAID ONCE, AT BOOT, BECAUSE IT IS THE SINGLE MOST CONSEQUENTIAL FACT ABOUT
// THIS PROCESS. "Hosted" used to mean "the LinkedIn queue is never served here"
// and now means "served here, through a remote browser, for the workspaces that
// authorised it" -- and an operator who cannot tell those two apart from the
// log has no way to know whether their queue is moving.
{
  const mode = hostedExecutionMode();
  if (mode.problem) console.error(`LinkedIn hosted execution is misconfigured: ${mode.problem}`);
  else if (mode.available)
    console.log(
      `LinkedIn seats run server-side through ${mode.provider}, for workspaces that have authorised it. Every other safety gate is unchanged.`
    );
  else if (mode.hosted && runtime.linkedinLocalWorker.companionBrowser)
    console.log(
      'LinkedIn companion execution is enabled: a workspace is served only while its paired computer is connected. LinkedIn traffic leaves from that computer; a Trevra tab does not need to stay open.'
    );
  else if (mode.hosted)
    console.log(
      'LinkedIn execution is off on this hosted deployment: no cloud browser or companion relay is configured, so planned actions wait for a worker that can open one.'
    );
}

// A cycle already in flight when a signal arrives is allowed to finish; no NEW
// one is started. Bounded, because a hung cycle must not hold a deploy open --
// 20s sits inside the 30s grace a container runtime usually allows before
// SIGKILL. An agent run can outlast that, which is exactly why the reaper
// exists: what the drain cannot finish, the next worker writes off instead of
// leaving it to wedge that workspace's schedule forever.
// lc-debt: an enrichment run mid-verification (Hunter's 202 poll can run ~100s)
// outlasts this 20s drain, so the process exits with the lease held; the next
// claim after lease expiry costs one of MAX_ATTEMPTS=3 and resumes from the
// checkpoint. Upgrade: a drain-aware abort of the in-flight verify poll that
// releases the run (attempt returned) before exit.
const DRAIN_TIMEOUT_MS = 20_000;
let running = false;
let draining = false;
async function cycle(): Promise<void> {
  if (running || draining) return;
  running = true;
  // Before the schedule sweep, always: a run abandoned by a previous worker
  // keeps hasRunningAgentRun true and skips its workspace on every cycle, so
  // clearing it first is what lets a wedged workspace recover on this tick.
  // Its own try -- a failed reap must not cost the rest of the cycle.
  try {
    await reapStaleAgentRuns(db);
  } catch (error) {
    console.error('Worker could not reap abandoned agent runs', error);
  }
  try {
    await Promise.all([
      runAllAutomationCycles(db),
      runReadyPlaybooks(db),
      runDueAgentSchedules(db),
      runDueResearchSources(db),
      runDueBrandWatches(db),
      pruneCitationSamples(db)
    ]);
  } catch (error) {
    console.error('Worker control-plane cycle failed', error);
  } finally {
    running = false;
  }
}
// Campaign planning (database only), outbound action execution, and inbox
// maintenance use independent clocks. One long paced batch can no longer stop
// campaign planning or freeze the maintenance scheduler.
const SIDE_TASK_SEATS_PER_TICK = 50;
const CAMPAIGN_WORKSPACES_PER_TICK = 50;
const linkedInBrowserLane = createExclusiveLane();
const linkedinCycleHealth = createLinkedInCycleHealth();
let seatCursor: { workspaceId: string; seatKey: string } | null = null;
let planningWorkspaceCursor: string | null = null;
let postingWorkspaceCursor: string | null = null;

async function withLinkedInBrowser<T>(work: () => Promise<T>): Promise<T> {
  return runtime.linkedinLocalWorker.companionBrowser ? linkedInBrowserLane.run(work) : work();
}

async function linkedinPlanningCycle(): Promise<void> {
  if (draining || !runtime.linkedinLocalWorker.enabled) return;
  try {
    await linkedinCycleHealth.run('planning', async () => {
      // Hosted workspaces plan only while an authorised browser is available,
      // so an offline Companion does not accumulate stale unattended work.
      const allowSeat = hostedSeatFilter(db);
      const workspaces = await linkedinWorkspaceIdsForShard(db, {
        shard: linkedinShard,
        limit: CAMPAIGN_WORKSPACES_PER_TICK,
        after: planningWorkspaceCursor
      });
      planningWorkspaceCursor =
        workspaces.length < CAMPAIGN_WORKSPACES_PER_TICK
          ? null
          : (workspaces[workspaces.length - 1] ?? null);
      for (const workspaceId of workspaces) {
        if (draining) break;
        if (allowSeat && !(await allowSeat({ workspaceId }))) continue;
        await runLinkedInCampaignTick(db, workspaceId);
      }
    });
  } catch (error) {
    console.error('LinkedIn campaign planning cycle failed', error);
  }
}

async function linkedinOutboundCycle(): Promise<void> {
  if (draining || !runtime.linkedinLocalWorker.enabled) return;
  try {
    await linkedinCycleHealth.run('outbound', async () => {
      const allowSeat = hostedSeatFilter(db);
      await withLinkedInBrowser(async () => {
        if (draining) return;
        await runDueLinkedInActions(db, runtime.linkedinLocalWorker, {
          shard: linkedinShard,
          workerId: linkedinWorkerId,
          concurrency: seatConcurrencyForConfig(runtime.linkedinLocalWorker, true),
          ...(allowSeat ? { allowSeat } : {})
        });
      });
    });
  } catch (error) {
    console.error('LinkedIn outbound execution cycle failed', error);
  }
}

async function linkedinMaintenanceCycle(): Promise<void> {
  if (draining || !runtime.linkedinLocalWorker.enabled) return;
  try {
    await linkedinCycleHealth.run('maintenance', async () => {
      const allowSeat = hostedSeatFilter(db);
      await withLinkedInBrowser(async () => {
        if (draining) return;
        await runPendingSeatDetectRequests(db, runtime.linkedinLocalWorker, {
          shard: linkedinShard,
          ...(allowSeat ? { allowSeat } : {})
        });
      });
      const seats = await seatRefsForShard(db, {
        shard: linkedinShard,
        limit: SIDE_TASK_SEATS_PER_TICK,
        after: seatCursor
      });
      seatCursor =
        seats.length < SIDE_TASK_SEATS_PER_TICK ? null : (seats[seats.length - 1] ?? null);
      await runBounded(
        seats,
        seatConcurrencyForConfig(runtime.linkedinLocalWorker, true),
        async (seat) => {
          if (draining || (allowSeat && !(await allowSeat(seat)))) return;
          await withLinkedInBrowser(async () => {
            if (draining) return;
            await runLinkedInSideTasks(db, runtime.linkedinLocalWorker, {
              workspaceId: seat.workspaceId,
              seatKey: seat.seatKey
            });
          });
        }
      );
      // Publishing can operate the browser and belongs in maintenance, not
      // database-only planning. It retains the existing workspace rotation.
      const workspaces = await linkedinWorkspaceIdsForShard(db, {
        shard: linkedinShard,
        limit: CAMPAIGN_WORKSPACES_PER_TICK,
        after: postingWorkspaceCursor
      });
      postingWorkspaceCursor =
        workspaces.length < CAMPAIGN_WORKSPACES_PER_TICK
          ? null
          : (workspaces[workspaces.length - 1] ?? null);
      for (const workspaceId of workspaces) {
        if (draining) break;
        if (allowSeat && !(await allowSeat({ workspaceId }))) continue;
        await withLinkedInBrowser(async () => {
          if (!draining)
            await runLinkedInPostTick(db, runtime.linkedinLocalWorker, { workspaceId });
        });
      }
    });
  } catch (error) {
    console.error('LinkedIn inbox and maintenance cycle failed', error);
  }
}
await cycle();
const timer = setInterval(() => void cycle(), runtime.automationIntervalMs);
timer.unref();
// A call started first is not a completed call: the old startup queued the
// outbound browser lane behind session detection but *ahead* of the inbox,
// potentially sending a follow-up before a newly received reply was recorded.
// Complete the first maintenance visit before starting outbound. Planning
// proceeds independently, and every subsequent cycle keeps its own timer.
const linkedinStartup = createLinkedInStartupCoordinator();
void linkedinStartup
  .start({
    maintenance: linkedinMaintenanceCycle,
    planning: linkedinPlanningCycle,
    outbound: linkedinOutboundCycle,
    onPlanningError: (error) => console.error('LinkedIn startup planning failed', error)
  })
  .catch((error) => console.error('LinkedIn initial maintenance failed', error));
const linkedinMaintenanceTimer = setInterval(
  () => void linkedinMaintenanceCycle(),
  runtime.automationIntervalMs
);
linkedinMaintenanceTimer.unref();
const linkedinPlanningTimer = setInterval(
  () => void linkedinPlanningCycle(),
  runtime.automationIntervalMs
);
linkedinPlanningTimer.unref();
const linkedinOutboundTimer = setInterval(() => {
  if (linkedinStartup.outboundMayRun()) void linkedinOutboundCycle();
}, runtime.automationIntervalMs);
linkedinOutboundTimer.unref();
// Presence alerting is operational monitoring, not business automation. It
// must not inherit a deployment's five-minute automation cadence, otherwise a
// five-minute disconnect grace can become almost ten minutes before the first
// email attempt. Scan independently once a minute; the DB marker makes repeated
// scans idempotent across replicas via durable notification claims;
// notifyDisconnectedCompanionDevices isolates delivery failures per device.
const COMPANION_PRESENCE_SCAN_MS = 60_000;
let companionPresenceRunning = false;
async function companionPresenceCycle(): Promise<void> {
  if (companionPresenceRunning || draining) return;
  companionPresenceRunning = true;
  try {
    await Promise.all([
      notifyDisconnectedCompanionDevices(db),
      notifyCompanionSeatAttentionEmails(db)
    ]);
  } catch (error) {
    console.error('Worker companion-presence cycle failed', error);
  } finally {
    companionPresenceRunning = false;
  }
}
await companionPresenceCycle();
const companionPresenceTimer = setInterval(
  () => void companionPresenceCycle(),
  COMPANION_PRESENCE_SCAN_MS
);
companionPresenceTimer.unref();
// A healthy scheduler can still leave approved customer outreach overdue.
// Check a bounded set of running campaigns separately and notify the owner
// only when the same existing safety gate was open continuously for two hours.
// Durable PostgreSQL claims deduplicate alert delivery across worker replicas.
// No browser interaction or LinkedIn send is initiated by this monitor.
const LINKEDIN_STALL_SCAN_MS = 5 * 60_000;
let linkedinStallRunning = false;
async function linkedinStallCycle(): Promise<void> {
  if (linkedinStallRunning || draining || !runtime.linkedinLocalWorker.enabled) return;
  linkedinStallRunning = true;
  try {
    const result = await notifyStalledLinkedInCampaigns(db, { limit: 30 });
    linkedinStallLastResult = {
      ...result,
      checkedAt: new Date().toISOString(),
      lastError: null
    };
  } catch (error) {
    linkedinStallLastResult = {
      ...linkedinStallLastResult,
      checkedAt: new Date().toISOString(),
      lastError: 'Campaign stall scan failed; see worker logs.'
    };
    console.error('Worker LinkedIn stalled campaign scan failed', error);
  } finally {
    linkedinStallRunning = false;
  }
}
void linkedinStallCycle();
const linkedinStallTimer = setInterval(() => void linkedinStallCycle(), LINKEDIN_STALL_SCAN_MS);
linkedinStallTimer.unref();

// HTTPS webhooks run independently: an unresponsive customer endpoint must
// not hold the automation sweep. Without an operator hostname allowlist this
// pass returns immediately without reserving or sending any external work.
let outboundWebhookRunning = false;
async function outboundWebhookCycle(): Promise<void> {
  if (outboundWebhookRunning || draining) return;
  outboundWebhookRunning = true;
  try {
    await dispatchOutboundWebhookDeliveries(db, { limit: 10 });
  } catch (error) {
    console.error('Worker outbound webhook cycle failed', error);
  } finally {
    outboundWebhookRunning = false;
  }
}
void outboundWebhookCycle();
const outboundWebhookTimer = setInterval(() => void outboundWebhookCycle(), 60_000);
outboundWebhookTimer.unref();

// Sending-domain DNS re-checks get their OWN loop and in-flight flag, like the
// LinkedIn loop above: a sweep walks SPF/DKIM/DMARC for up to 25 domains
// against real resolvers, and inside `cycle()`'s Promise.all a slow resolver
// would hold `running` and delay the playbook engine for as long as DNS took.
// The sweep bounds itself (DELIVERABILITY_REFRESH_DEADLINE_MS); domains it does
// not reach stay due for the next tick. Not awaited at boot for the same reason.
let emailDeliverabilityRunning = false;
async function emailDeliverabilityCycle(): Promise<void> {
  if (emailDeliverabilityRunning || draining) return;
  emailDeliverabilityRunning = true;
  try {
    await refreshDueEmailDeliverability(db, { shouldStop: () => draining });
  } catch (error) {
    console.error('Worker email deliverability cycle failed', error);
  } finally {
    emailDeliverabilityRunning = false;
  }
}
void emailDeliverabilityCycle();
const emailDeliverabilityTimer = setInterval(
  () => void emailDeliverabilityCycle(),
  runtime.automationIntervalMs
);
emailDeliverabilityTimer.unref();
// Contact enrichment gets its own loop for the same reason as LinkedIn: one
// run makes paced paid calls for minutes, and inside `cycle()` it would hold
// the automation sweep behind it. On drain, `shouldStop` hands the run back to
// the queue before its next paid call; it keeps its per-domain checkpoint and
// the next claim resumes it under a new `attempts` fence.
let enrichmentRunning = false;
async function enrichmentCycle(): Promise<void> {
  if (enrichmentRunning || draining) return;
  enrichmentRunning = true;
  try {
    await runQueuedEnrichmentRuns(db, { shouldStop: () => draining });
  } catch (error) {
    console.error('Worker enrichment cycle failed', error);
  } finally {
    enrichmentRunning = false;
  }
}
void enrichmentCycle();
const enrichmentTimer = setInterval(() => void enrichmentCycle(), runtime.automationIntervalMs);
enrichmentTimer.unref();

async function shutdown(signal: string) {
  if (draining) return;
  draining = true;
  console.log(`${signal} received; draining worker`);
  clearInterval(timer);
  clearInterval(linkedinMaintenanceTimer);
  clearInterval(linkedinPlanningTimer);
  clearInterval(linkedinOutboundTimer);
  clearInterval(companionPresenceTimer);
  clearInterval(linkedinStallTimer);
  clearInterval(emailDeliverabilityTimer);
  clearInterval(enrichmentTimer);
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  while (
    (running ||
      Object.values(linkedinCycleHealth.snapshot()).some((state) => state.running) ||
      companionPresenceRunning ||
      emailDeliverabilityRunning ||
      enrichmentRunning) &&
    Date.now() < deadline
  )
    await new Promise((resolve) => setTimeout(resolve, 200));
  if (running)
    console.error(
      `Worker still mid-cycle after ${DRAIN_TIMEOUT_MS}ms; exiting anyway. Any agent run left in flight is written off by the next worker's reap.`
    );
  if (emailDeliverabilityRunning)
    console.error(
      `Email deliverability sweep still mid-domain after ${DRAIN_TIMEOUT_MS}ms; exiting anyway. Its unfinished domains stay due for the next worker.`
    );
  if (enrichmentRunning)
    console.error(
      `Enrichment run still mid-run after ${DRAIN_TIMEOUT_MS}ms; exiting anyway. Its lease expires and the next worker resumes it from its last domain checkpoint.`
    );
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await temporalWorker?.shutdown();
  // Before the pool closes: a browser left open outlives this process and
  // holds the operator's profile directory locked, so the next worker cannot
  // attach to it. A seat lease left behind expires on its own, and the row
  // keeps saying which host holds that seat's profile -- which is exactly what
  // the next worker on this host needs it to say.
  await closeLinkedInBrowser();
  await db.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
