import { describe, expect, it } from 'vitest';
import { createExclusiveLane, createLinkedInCycleHealth } from './linkedin-runtime';

describe('LinkedIn worker scheduling lanes', () => {
  it('serializes browser work even when jobs start from independent loops', async () => {
    const lane = createExclusiveLane();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = lane.run(async () => {
      order.push('send-start');
      await new Promise<void>((resolve) => (releaseFirst = resolve));
      order.push('send-end');
    });
    await Promise.resolve();
    const second = lane.run(async () => {
      order.push('inbox-start');
      order.push('inbox-end');
    });
    await Promise.resolve();
    expect(lane.snapshot()).toEqual({ running: true, queued: 1 });
    expect(order).toEqual(['send-start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['send-start', 'send-end', 'inbox-start', 'inbox-end']);
    expect(lane.snapshot()).toEqual({ running: false, queued: 0 });
  });

  it('releases the browser lane after an error', async () => {
    const lane = createExclusiveLane();
    await expect(
      lane.run(async () => {
        throw new Error('browser disconnected');
      })
    ).rejects.toThrow('browser disconnected');
    await expect(lane.run(async () => 'recovered')).resolves.toBe('recovered');
  });

  it('does not allow overlapping ticks of the same job, but independent jobs proceed', async () => {
    const health = createLinkedInCycleHealth();
    let release!: () => void;
    const outbound = health.run('outbound', () => new Promise<void>((r) => (release = r)));
    await Promise.resolve();
    const duplicate = health.run('outbound', async () => {
      throw new Error('must not run');
    });
    let planned = false;
    await health.run('planning', async () => {
      planned = true;
    });
    expect(planned).toBe(true);
    expect(health.snapshot().outbound.running).toBe(true);
    expect(health.snapshot().planning.lastCompletedAt).not.toBeNull();
    await duplicate;
    release();
    await outbound;
    expect(health.snapshot().outbound.running).toBe(false);
  });

  it('reports a failed cycle without leaking the underlying error', async () => {
    const health = createLinkedInCycleHealth();
    await expect(
      health.run('maintenance', async () => {
        throw new Error('secret account URL');
      })
    ).rejects.toThrow('secret account URL');
    expect(health.snapshot().maintenance.lastError).not.toContain('secret');
    expect(health.snapshot().maintenance.lastFailedAt).not.toBeNull();
    await health.run('maintenance', async () => {});
    expect(health.snapshot().maintenance.lastError).toBeNull();
  });
});
