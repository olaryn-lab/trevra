import type { Db } from '../db.js';
import {
  emailComplianceFooterUnavailable,
  OUTREACH_OPT_OUT_SENTENCE,
  type EmailComplianceIssue,
  type EmailComplianceProvider
} from '../email/compliance.js';
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

async function bounded<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`The sender identity read took longer than ${timeoutMs}ms`)),
          timeoutMs
        );
        timer.unref();
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function reportFailure(read: 'footer' | 'blockers', error: unknown): void {
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
  options: { timeoutMs?: number } = {}
): EmailComplianceProvider {
  const timeoutMs = options.timeoutMs ?? SENDER_COMPLIANCE_READ_TIMEOUT_MS;
  return {
    async footer(db: Db, workspaceId: string): Promise<string | null> {
      try {
        return senderComplianceFooter(await bounded(getSenderIdentity(db, workspaceId), timeoutMs));
      } catch (error) {
        reportFailure('footer', error);
        return null;
      }
    },
    // listId is unused until the lead-list lawful-basis blocker (Phase E Task 11).
    async blockers(
      db: Db,
      workspaceId: string,
      _listId: string | null
    ): Promise<EmailComplianceIssue[]> {
      try {
        return identityBlockers(await bounded(getSenderIdentity(db, workspaceId), timeoutMs));
      } catch (error) {
        reportFailure('blockers', error);
        return [emailComplianceFooterUnavailable()];
      }
    }
  };
}

export const senderComplianceProvider = createSenderComplianceProvider();
