import type { Db } from '../db.js';
import {
  emailComplianceFooterUnavailable,
  OUTREACH_OPT_OUT_SENTENCE,
  type EmailComplianceIssue,
  type EmailComplianceProvider
} from '../email/compliance.js';
import { JURISDICTION_RULES_DISCLAIMER } from './jurisdiction-rules.js';
import { LEAD_LIST_BASIS_CHECK_LIMIT, countLeadListMissingEmailBasis } from './lawful-basis.js';
import { getSenderIdentity, identityBlockers, type SenderIdentity } from './sender-identity.js';

/* ---------------------------------------------------------------------------
 * THE REAL EMAIL COMPLIANCE PROVIDER.
 *
 * Registered at process entry (src/server/index.ts, src/worker/index.ts), never
 * inside createApp. The footer is built from the workspace sender identity and
 * is the non-removable tail of every outreach body: preparation appends it,
 * and the send step re-reads it and refuses a body that does not end with it.
 *
 * FAILS CLOSED. Each read is one workspace-scoped primary-key lookup, bounded
 * by SENDER_COMPLIANCE_READ_TIMEOUT_MS. On error or timeout there is no footer
 * and the plan carries email_compliance_footer_unavailable, so nothing is
 * planned, prepared or sent. Not legal advice; verify with counsel.
 * ------------------------------------------------------------------------ */

export const SENDER_COMPLIANCE_READ_TIMEOUT_MS = 3_000;
// The lead-list count walks up to LEAD_LIST_BASIS_CHECK_LIMIT people, so it gets its own bound.
export const LEAD_LIST_BASIS_READ_TIMEOUT_MS = 10_000;

async function bounded<T>(
  work: Promise<T>,
  timeoutMs: number,
  what = 'The sender identity read'
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} took longer than ${timeoutMs}ms`)),
          timeoutMs
        );
        timer.unref();
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function reportFailure(read: 'footer' | 'blockers' | 'lead-list basis', error: unknown): void {
  // The message only: never the workspace's address or URL.
  console.error(
    `Sender compliance ${read} unavailable; failing closed`,
    error instanceof Error ? error.message : String(error)
  );
}

/**
 * Legal name (when saved), postal address, privacy policy URL, then the visible
 * opt-out line. Null while the postal address or privacy policy URL is missing,
 * exactly when identityBlockers() reports a blocker.
 */
export function senderComplianceFooter(identity: SenderIdentity): string | null {
  if (!identity.postalAddress || !identity.privacyPolicyUrl) return null;
  return [
    identity.legalName,
    identity.postalAddress,
    `Privacy policy: ${identity.privacyPolicyUrl}`,
    OUTREACH_OPT_OUT_SENTENCE
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

export function createSenderComplianceProvider(
  options: { timeoutMs?: number; leadListTimeoutMs?: number } = {}
): EmailComplianceProvider {
  const timeoutMs = options.timeoutMs ?? SENDER_COMPLIANCE_READ_TIMEOUT_MS;
  const leadListTimeoutMs = options.leadListTimeoutMs ?? LEAD_LIST_BASIS_READ_TIMEOUT_MS;

  // Counts only: how many, never who. Fails closed on error or timeout.
  async function leadListBlockers(
    db: Db,
    workspaceId: string,
    listId: string
  ): Promise<EmailComplianceIssue[]> {
    try {
      const basis = await bounded(
        countLeadListMissingEmailBasis(db, workspaceId, listId),
        leadListTimeoutMs,
        'The lead-list lawful basis check'
      );
      if (basis.missing === 0) return [];
      return [
        {
          code: 'recipient_lawful_basis_missing',
          message: `${basis.missing} of ${basis.checked} people with an email in this list have no recorded lawful basis for cold email in their country${
            basis.truncated ? ` (only the first ${LEAD_LIST_BASIS_CHECK_LIMIT} were checked)` : ''
          }. ${JURISDICTION_RULES_DISCLAIMER}`,
          actionHref: '/outreach/new'
        }
      ];
    } catch (error) {
      reportFailure('lead-list basis', error);
      return [
        {
          code: 'recipient_lawful_basis_missing',
          message: `Trevra could not check this list for a lawful basis to email. Try again. ${JURISDICTION_RULES_DISCLAIMER}`,
          actionHref: '/outreach/new'
        }
      ];
    }
  }

  return {
    async footer(db: Db, workspaceId: string): Promise<string | null> {
      try {
        return senderComplianceFooter(await bounded(getSenderIdentity(db, workspaceId), timeoutMs));
      } catch (error) {
        reportFailure('footer', error);
        return null;
      }
    },
    async blockers(
      db: Db,
      workspaceId: string,
      listId: string | null
    ): Promise<EmailComplianceIssue[]> {
      let identity: EmailComplianceIssue[];
      try {
        identity = identityBlockers(await bounded(getSenderIdentity(db, workspaceId), timeoutMs));
      } catch (error) {
        reportFailure('blockers', error);
        identity = [emailComplianceFooterUnavailable()];
      }
      return listId
        ? [...identity, ...(await leadListBlockers(db, workspaceId, listId))]
        : identity;
    }
  };
}

export const senderComplianceProvider = createSenderComplianceProvider();
