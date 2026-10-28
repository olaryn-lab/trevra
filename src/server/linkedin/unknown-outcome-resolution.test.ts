import { describe, expect, it } from 'vitest';
import { linkedinUnknownResolutionRequest } from './unknown-outcome-resolution.js';

describe('LinkedIn unknown-effect reconciliation boundary', () => {
  it('rejects one-click retry and incomplete or forged attestations', () => {
    for (const payload of [
      { resolution: 'retry' },
      { resolution: 'retry', verifiedNotSent: false, verificationMethod: 'linkedin_sent_items' },
      { resolution: 'retry', verifiedNotSent: true, verificationMethod: 'guessed' },
      { resolution: 'retry', verifiedNotSent: true },
      {
        resolution: 'retry',
        verifiedNotSent: true,
        verificationMethod: 'linkedin_sent_items',
        bypass: true
      }
    ])
      expect(linkedinUnknownResolutionRequest.safeParse(payload).success).toBe(false);
  });
  it('allows an explicitly verified retry decision', () => {
    expect(
      linkedinUnknownResolutionRequest.parse({
        resolution: 'retry',
        verifiedNotSent: true,
        verificationMethod: 'linkedin_sent_items'
      })
    ).toMatchObject({ resolution: 'retry', verifiedNotSent: true });
  });
  it('preserves sent/skip without making them eligible for retry', () => {
    expect(linkedinUnknownResolutionRequest.parse({ resolution: 'sent' }).resolution).toBe('sent');
    expect(linkedinUnknownResolutionRequest.parse({ resolution: 'skip' }).resolution).toBe('skip');
    expect(
      linkedinUnknownResolutionRequest.safeParse({
        resolution: 'skip',
        verifiedNotSent: true
      }).success
    ).toBe(false);
  });
});
