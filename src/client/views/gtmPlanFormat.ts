import type {
  EmailOutreachSkipReason,
  PreparedEmailOutreachResult
} from '../../server/email/types';

const SKIP_LABELS: Array<[EmailOutreachSkipReason, string]> = [
  ['no_email', 'without an email address'],
  ['unresolved_person', 'not yet matched to one Person'],
  ['do_not_contact', 'marked do-not-contact'],
  ['suppressed', 'unsubscribed or suppressed'],
  ['already_contacted', 'already emailed'],
  ['already_pending', 'already waiting for approval']
];

/** One sentence that accounts for every Person an email preparation skipped. */
export function emailSkipSummary(skipped: PreparedEmailOutreachResult['skipped']): string {
  if (skipped.length === 0) return '';
  const parts = SKIP_LABELS.flatMap(([reason, label]) => {
    const count = skipped.filter((item) => item.reason === reason).length;
    return count > 0 ? [`${count} ${label}`] : [];
  });
  return `Skipped ${skipped.length}: ${parts.join(', ')}.`;
}

export interface PlanIssue {
  code: string;
  message: string;
  actionHref?: string;
}

/**
 * Plan defaults are untyped JSON. Keep only well-formed issues, and keep a link
 * only when it stays inside the app.
 */
export function planIssues(value: unknown): PlanIssue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): PlanIssue[] => {
    if (!item || typeof item !== 'object') return [];
    const { code, message, actionHref } = item as Record<string, unknown>;
    if (typeof code !== 'string' || typeof message !== 'string') return [];
    const inApp =
      typeof actionHref === 'string' && actionHref.startsWith('/') && !actionHref.startsWith('//');
    return [{ code, message, ...(inApp ? { actionHref } : {}) }];
  });
}
