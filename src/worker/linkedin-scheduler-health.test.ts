import { describe, expect, it } from 'vitest';
import { linkedInSchedulerStatus, type LinkedInCycleSnapshot } from './linkedin-runtime';

const now = new Date('2026-10-27T12:00:00Z');
const intervalMs = 60_000;
const sample = (): LinkedInCycleSnapshot => {
  const state = {
    running: false,
    lastStartedAt: '2026-10-27T11:59:00Z',
    lastCompletedAt: '2026-10-27T11:59:30Z',
    lastFailedAt: null,
    lastError: null
  };
  return { planning: { ...state }, outbound: { ...state }, maintenance: { ...state } };
};
const check = (
  cycles: LinkedInCycleSnapshot,
  extra: Partial<Parameters<typeof linkedInSchedulerStatus>[1]> = {}
) =>
  linkedInSchedulerStatus(cycles, {
    now,
    startedAt: new Date('2026-10-27T11:58:00Z'),
    intervalMs,
    enabled: true,
    discoveryHealthy: true,
    ...extra
  });

describe('LinkedIn scheduler health report', () => {
  it('reports healthy independent cycles and valid long outbound batches', () => {
    expect(check(sample())).toMatchObject({ healthy: true, state: 'healthy', issues: [] });
    const cycles = sample();
    cycles.outbound.running = true;
    cycles.outbound.lastStartedAt = '2026-10-27T10:00:00Z';
    expect(check(cycles).healthy).toBe(true);
  });
  it('reports a stalled database planning loop', () => {
    const cycles = sample();
    cycles.planning.running = true;
    cycles.planning.lastStartedAt = '2026-10-27T11:30:00Z';
    expect(check(cycles)).toMatchObject({
      healthy: false,
      state: 'degraded',
      issues: ['planning has been running unusually long.']
    });
  });
  it('reports a cycle missing more than three scheduling intervals with minimum grace', () => {
    const cycles = sample();
    cycles.maintenance.lastStartedAt = '2026-10-27T11:30:00Z';
    expect(check(cycles)).toMatchObject({ healthy: false, state: 'degraded' });
    expect(check(cycles).issues).toContain('maintenance has not started recently.');
  });
  it('does not invent startup failures and supports disabled deployments', () => {
    const cycles = sample();
    cycles.maintenance.lastStartedAt = null;
    expect(check(cycles).state).toBe('starting');
    expect(check(cycles, { enabled: false })).toMatchObject({
      healthy: true,
      state: 'disabled',
      issues: []
    });
  });
  it('reports failures and queue-discovery problems without leaking internal errors', () => {
    const cycles = sample();
    cycles.outbound.lastError = 'This LinkedIn cycle failed; see worker logs.';
    const result = check(cycles, { discoveryHealthy: false });
    expect(result.state).toBe('degraded');
    expect(result.issues).toContain('Action queue discovery failed.');
    expect(result.issues).toContain('outbound failed; see worker logs.');
  });
});
