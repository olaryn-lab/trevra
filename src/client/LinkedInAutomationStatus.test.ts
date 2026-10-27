import { describe, expect, it } from 'vitest';
import type { LinkedInSeat } from '../server/linkedin/seats';
import type { ManagedCampaign } from '../server/linkedin/managed-campaigns';
import type { LinkedInWorkerStatus, LinkedInCompanionStatus, LinkedInSeatResponse } from './api';
import { linkedInAutomationStatus } from './LinkedInAutomationStatus';

const seat = { seatKey: 'owner', posture: 'steady' } as LinkedInSeat;
const worker = { enabled: true, ready: true, companionBrowser: true } as LinkedInWorkerStatus;
const device = {
  devices: [{ online: true }],
  attention: [],
  recoveries: []
} as unknown as LinkedInCompanionStatus;
const details = {
  owner: { auth: { sessionValidAt: '2026-10-27T06:00:00Z' } }
} as unknown as Record<string, LinkedInSeatResponse>;
const campaign = (status: string, senderKeys: string[] = ['owner']) =>
  ({ status, senderKeys, seatKey: 'owner' }) as ManagedCampaign;
const input = {
  accounts: [seat],
  details,
  worker,
  companion: device,
  campaigns: [] as ManagedCampaign[]
};

describe('one LinkedIn status for the user', () => {
  it('does not call a connected computer active outreach', () => {
    expect(linkedInAutomationStatus(input)).toMatchObject({
      kind: 'waiting',
      title: 'Waiting for a campaign'
    });
  });
  it('prioritizes offline or recovery over campaigns running', () => {
    expect(
      linkedInAutomationStatus({
        ...input,
        campaigns: [campaign('running')],
        companion: { ...device, devices: [{ ...device.devices[0]!, online: false }] }
      })
    ).toMatchObject({ kind: 'attention', title: 'Needs attention' });
    expect(
      linkedInAutomationStatus({
        ...input,
        campaigns: [campaign('running')],
        companion: {
          ...device,
          attention: [
            {
              seatKey: 'owner',
              label: 'Owner',
              kind: 'challenge',
              message: 'Sign in',
              since: '2026-10-27T06:00:00Z'
            }
          ]
        }
      })
    ).toMatchObject({ kind: 'attention' });
  });
  it('shows paused accounts before campaign status', () => {
    expect(
      linkedInAutomationStatus({
        ...input,
        accounts: [{ ...seat, posture: 'paused' }],
        campaigns: [campaign('running')]
      })
    ).toMatchObject({ kind: 'paused' });
  });
  it('requires confirmed sign-in rather than just a paired computer', () => {
    expect(linkedInAutomationStatus({ ...input, details: {} })).toMatchObject({
      kind: 'attention'
    });
  });
  it('treats only related running campaigns as working', () => {
    const other = { ...campaign('running', ['different']), seatKey: 'different' };
    expect(linkedInAutomationStatus({ ...input, campaigns: [other] }).kind).toBe('waiting');
    expect(linkedInAutomationStatus({ ...input, campaigns: [campaign('running')] }).kind).toBe(
      'working'
    );
  });
  it('does not report ready when a required source is unreadable', () => {
    expect(linkedInAutomationStatus({ ...input, companion: null }).kind).toBe('checking');
  });
});
