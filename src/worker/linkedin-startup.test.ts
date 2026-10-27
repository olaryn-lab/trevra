import { describe, expect, it } from 'vitest';
import { createLinkedInStartupCoordinator } from './linkedin-startup';

describe('LinkedIn startup scheduling', () => {
  it('runs planning immediately but defers outbound until first maintenance finishes', async () => {
    const coordinator = createLinkedInStartupCoordinator();
    const events: string[] = [];
    let releaseMaintenance!: () => void;
    const started = coordinator.start({
      maintenance: async () => {
        events.push('maintenance-start');
        await new Promise<void>((resolve) => (releaseMaintenance = resolve));
        events.push('maintenance-end');
      },
      planning: async () => {
        events.push('planning');
      },
      outbound: async () => {
        events.push('outbound');
      },
      onPlanningError: () => {}
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toContain('planning');
    expect(events).not.toContain('outbound');
    expect(coordinator.outboundMayRun()).toBe(false);
    releaseMaintenance();
    await started;
    expect(events.indexOf('maintenance-end')).toBeLessThan(events.indexOf('outbound'));
    expect(coordinator.outboundMayRun()).toBe(true);
  });

  it('does not await slow planning before beginning outbound', async () => {
    const coordinator = createLinkedInStartupCoordinator();
    let finishPlanning!: () => void;
    let outboundStarted = false;
    await coordinator.start({
      maintenance: async () => {},
      planning: () => new Promise<void>((resolve) => (finishPlanning = resolve)),
      outbound: async () => {
        outboundStarted = true;
      },
      onPlanningError: () => {}
    });
    expect(outboundStarted).toBe(true);
    finishPlanning();
  });

  it('reports the initial readiness gate while maintenance is pending', async () => {
    const coordinator = createLinkedInStartupCoordinator();
    let release!: () => void;
    const started = coordinator.start({
      maintenance: () => new Promise<void>((resolve) => (release = resolve)),
      planning: async () => {},
      outbound: async () => {},
      onPlanningError: () => {}
    });
    expect(coordinator.outboundMayRun()).toBe(false);
    release();
    await started;
    expect(coordinator.outboundMayRun()).toBe(true);
  });

  it('releases the boot gate if maintenance throws, without starting outbound automatically', async () => {
    const coordinator = createLinkedInStartupCoordinator();
    let sent = false;
    await expect(
      coordinator.start({
        maintenance: async () => {
          throw new Error('maintenance failed');
        },
        planning: async () => {},
        outbound: async () => {
          sent = true;
        },
        onPlanningError: () => {}
      })
    ).rejects.toThrow('maintenance failed');
    expect(coordinator.outboundMayRun()).toBe(true);
    expect(sent).toBe(false);
  });
});
