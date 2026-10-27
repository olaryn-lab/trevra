/**
 * The browser maintenance visit must get the first chance to discover replies
 * before the outbound worker starts driving that same LinkedIn profile.
 *
 * Campaign planning uses only PostgreSQL and is never blocked by browsing.
 * Subsequent cycles retain their own clocks, with existing browser exclusivity.
 */
export function createLinkedInStartupCoordinator() {
  let initialMaintenanceSettled = false;
  return {
    outboundMayRun(): boolean {
      return initialMaintenanceSettled;
    },
    async start(tasks: {
      maintenance: () => Promise<void>;
      planning: () => Promise<void>;
      outbound: () => Promise<void>;
      onPlanningError: (error: unknown) => void;
    }): Promise<void> {
      // Deliberately do not await planning. A slow planning database query
      // cannot block completion of initial browser maintenance or outbound.
      void Promise.resolve().then(tasks.planning).catch(tasks.onPlanningError);
      try {
        await tasks.maintenance();
      } finally {
        // The maintenance loop reports individual browser refusals separately.
        // Keep the send-time safety gates authoritative after a failed pass.
        initialMaintenanceSettled = true;
      }
      await tasks.outbound();
    }
  };
}
