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
