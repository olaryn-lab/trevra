import { describe, expect, it } from 'vitest';
import { emailEventBranchKeys, emailEventKindForCondition } from './email-event-kind.js';

describe('canonical email event and workflow condition vocabulary', () => {
  it.each([
    ['email_replied', 'reply', 'external:email_replied'],
    ['email_bounced', 'bounce', 'external:email_bounced'],
    ['email_opened', 'opened', 'external:email_opened'],
    ['email_clicked', 'clicked', 'external:email_clicked']
  ])('%s resolves to persisted event %s', (condition, kind, expected) => {
    const event = emailEventKindForCondition(condition);
    expect(event).toBe(kind);
    expect(emailEventBranchKeys(event!)).toContain(expected);
    expect(emailEventBranchKeys(event!)).toContain(`external:email_${kind}`);
  });
  it('does not invent keys for unrelated conditions', () => {
    expect(emailEventKindForCondition('connected')).toBeNull();
  });
});
