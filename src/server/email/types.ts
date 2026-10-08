/** Mail providers Trevra can send through, keyed by their DNS footprint. */
export type MailProvider = 'google' | 'microsoft' | 'zoho';

/** One blocker or warning, shaped like a GTM plan blocker. */
export interface EmailChannelIssue {
  code: string;
  message: string;
  actionHref?: string;
}

export interface DeliverabilityCheck {
  status: 'pass' | 'fail' | 'unknown' | 'provider_managed';
  detail: string;
  record: string | null;
  selector?: string | null;
  lookups?: number;
}

export type DeliverabilityStatus = 'pass' | 'fail' | 'unknown';

export interface DeliverabilityEvaluation {
  domain: string;
  provider: MailProvider;
  status: DeliverabilityStatus;
  spf: DeliverabilityCheck;
  dkim: DeliverabilityCheck;
  dmarc: DeliverabilityCheck;
  blockers: EmailChannelIssue[];
  warnings: EmailChannelIssue[];
}

export interface StoredDeliverability extends DeliverabilityEvaluation {
  checkedAt: string;
  expiresAt: string;
}

export interface EmailChannelMailbox {
  connectionId: string;
  provider: string;
  providerKey: MailProvider;
  displayName: string | null;
  address: string | null;
}

export type InboundSyncStatus = 'starting' | 'syncing' | 'unavailable';

export interface EmailInboundMailboxState {
  connectionId: string;
  address: string;
  syncStatus: InboundSyncStatus;
  syncError: string | null;
  designatedAt: string;
  lastRecordAt: string | null;
  nango: { status: string; finishedAt: string | null } | null;
}

export interface EmailChannelStatus {
  unsubscribe: { oneClick: boolean; mailto: boolean; detail: string };
  mailboxes: Array<
    EmailChannelMailbox & {
      deliverability: StoredDeliverability | null;
      /** The owner-set DKIM selector for this mailbox's sending domain. */
      dkimSelector: string | null;
    }
  >;
  inbound: EmailInboundMailboxState | null;
}

export type EmailOutreachSkipReason =
  | 'no_email'
  | 'unresolved_person'
  | 'do_not_contact'
  | 'suppressed'
  | 'already_pending'
  | 'already_contacted';

export interface PreparedEmailOutreachResult {
  prepared: Array<{ contactId: string; personId: string; runId: string }>;
  skipped: Array<{ contactId: string; reason: EmailOutreachSkipReason }>;
  connectionId: string;
  senderAddress: string;
  /** True when the list had more members than one preparation reads. */
  truncated: boolean;
  duplicate: boolean;
}
