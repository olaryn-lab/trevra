/**
 * The hosted worker has three independent kinds of LinkedIn work:
 * planning (database only), sending (paced browser work), and maintenance
 * (inbox/replies, detection and post publication).
 *
 * A Companion owns a single Chrome profile on one laptop. Separate timers must
 * not make two browser jobs control that profile at the same time. The small
 * FIFO below serializes browser jobs without serializing database-only planning.
 * No timeout can safely unlock an in-progress external side effect.
 */
export function createExclusiveLane() {
  let tail: Promise<void> = Promise.resolve();
  let running = false;
  let queued = 0;
  return {
    async run<T>(work: () => Promise<T>): Promise<T> {
      queued += 1;
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      queued -= 1;
      running = true;
      try {
        return await work();
      } finally {
        running = false;
        release();
      }
    },
    snapshot() {
      return { running, queued };
    }
  };
}

export type LinkedInCycleName = 'planning' | 'outbound' | 'maintenance';

export type LinkedInCycleSnapshot = Record<
  LinkedInCycleName,
  {
    running: boolean;
    lastStartedAt: string | null;
    lastCompletedAt: string | null;
    lastFailedAt: string | null;
    lastError: string | null;
  }
>;

/**
 * A healthy Node process is not necessarily a healthy LinkedIn scheduler.
 * Report stale or failed loops separately without turning the whole worker's
 * readiness endpoint into 503 (it also serves other product subsystems).
 *
 * Long browser batches are valid; staleness is judged on a cycle that is NOT
 * currently running. Planning is the exception: a >10 minute database-only
 * plan is itself an incident.
 */
export function linkedInSchedulerStatus(
  cycles: LinkedInCycleSnapshot,
  options: {
    now: Date;
    startedAt: Date;
    intervalMs: number;
    enabled: boolean;
    discoveryHealthy: boolean;
  }
): { healthy: boolean; state: 'disabled' | 'starting' | 'healthy' | 'degraded'; issues: string[] } {
  if (!options.enabled) return { healthy: true, state: 'disabled', issues: [] };
  const issues: string[] = [];
  if (!options.discoveryHealthy) issues.push('Action queue discovery failed.');
  const graceMs = Math.max(3 * options.intervalMs, 10 * 60_000);
  const nowMs = options.now.getTime();
  for (const name of ['planning', 'outbound', 'maintenance'] as const) {
    const cycle = cycles[name];
    if (cycle.lastError) issues.push(name + ' failed; see worker logs.');
    const startedMs = cycle.lastStartedAt
      ? Date.parse(cycle.lastStartedAt)
      : options.startedAt.getTime();
    if (nowMs - startedMs > graceMs && !cycle.running)
      issues.push(name + ' has not started recently.');
    if (name === 'planning' && cycle.running && nowMs - startedMs > graceMs)
      issues.push('planning has been running unusually long.');
  }
  if (issues.length) return { healthy: false, state: 'degraded', issues };
  if (Object.values(cycles).some((cycle) => !cycle.lastStartedAt))
    return { healthy: true, state: 'starting', issues: [] };
  return { healthy: true, state: 'healthy', issues: [] };
}

export function createLinkedInCycleHealth() {
  const cycles: Record<
    LinkedInCycleName,
    {
      running: boolean;
      lastStartedAt: string | null;
      lastCompletedAt: string | null;
      lastFailedAt: string | null;
      lastError: string | null;
    }
  > = {
    planning: {
      running: false,
      lastStartedAt: null,
      lastCompletedAt: null,
      lastFailedAt: null,
      lastError: null
    },
    outbound: {
      running: false,
      lastStartedAt: null,
      lastCompletedAt: null,
      lastFailedAt: null,
      lastError: null
    },
    maintenance: {
      running: false,
      lastStartedAt: null,
      lastCompletedAt: null,
      lastFailedAt: null,
      lastError: null
    }
  };
  return {
    async run(name: LinkedInCycleName, work: () => Promise<void>): Promise<void> {
      const state = cycles[name];
      if (state.running) return;
      state.running = true;
      state.lastStartedAt = new Date().toISOString();
      try {
        await work();
        state.lastCompletedAt = new Date().toISOString();
        state.lastError = null;
      } catch (error) {
        state.lastFailedAt = new Date().toISOString();
        // Avoid exposing tokens, URLs or account data in /health. The detailed
        // error is logged separately in the loop's catch.
        state.lastError = 'This LinkedIn cycle failed; see worker logs.';
        throw error;
      } finally {
        state.running = false;
      }
    },
    snapshot() {
      return {
        planning: { ...cycles.planning },
        outbound: { ...cycles.outbound },
        maintenance: { ...cycles.maintenance }
      };
    }
  };
}
