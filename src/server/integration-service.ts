import { createHash } from 'node:crypto';
import { Nango } from '@nangohq/node';
import { z, ZodError } from 'zod';
import { notifyIntegrationNeedsReauth } from './notifications.js';
import type { AvailableIntegration } from '../shared/types.js';
import { id, type Db } from './db.js';
import { resolveContact } from './lead-capture/people.js';
import { accountForPerson, upsertPersonIdentity } from './person-identities.js';
import { projectCanonicalMessage } from './conversations.js';
import { meetingFromCalendarEvent, nangoRecordDeleted } from './meetings/google-calendar.js';
import { applyMeetingRecord, findMeetingPerson, workspaceUserEmails } from './meetings/ingest.js';
import { meetingKnown } from './meetings/store.js';
import {
  activeMeetingSchema,
  canonicalMeetingSchema,
  type CanonicalMeeting
} from './meetings/types.js';
import { assertNotSuppressed, SuppressionError } from './suppressions.js';
import {
  assertEmailDeliveryCapacity,
  claimEmailDelivery,
  markEmailDeliveryFailure,
  markEmailDeliverySent
} from './email-deliveries.js';
import {
  classifyDeliveryFailure,
  classifyVerifiedInboundEmail,
  type VerifiedEmailOutcome
} from './email-outcomes.js';
import { outreachUnsubscribeHeaders } from './email/unsubscribe.js';
import { emailComplianceProvider, OUTREACH_OPT_OUT_SENTENCE } from './email/compliance.js';
import { mailProviderFor } from './email/deliverability.js';
import {
  OUTREACH_REPLY_OPT_OUT_SENTENCE,
  UnsubscribePolicyError,
  assertUnsubscribeModeAllowed,
  parseOutreachUnsubscribeMode
} from './email/unsubscribe-policy.js';
import {
  ZOHO_MAIL_PROVIDER,
  ZohoMailError,
  readZohoAccount,
  readZohoSentMessageId,
  sendZohoMessage
} from './email/zoho-mail.js';
import {
  INBOUND_EMAIL_MESSAGE_MODEL,
  INBOUND_SYNC_FAILED_ERROR,
  INBOUND_SYNC_NAME,
  decideInboundMailboxRecord
} from './email/inbound-mailbox.js';

export const canonicalRecordSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('message'),
    id: z.string(),
    accountName: z.string().optional(),
    personName: z.string().optional(),
    personEmail: z.string().email().optional(),
    direction: z.enum(['inbound', 'outbound']),
    subject: z.string().default(''),
    body: z.string(),
    occurredAt: z.string().datetime(),
    externalUrl: z.string().url().optional(),
    // Set only by the inbound-messages sync (nango-integrations/*/syncs/inbound-messages.ts).
    mailboxAddress: z.string().email().optional(),
    internetMessageId: z.string().max(998).optional(),
    replyToMessageIds: z.array(z.string().max(998)).max(50).optional(),
    autoSubmitted: z.string().max(200).nullable().optional()
  }),
  z.object({
    kind: z.literal('opportunity'),
    id: z.string(),
    accountName: z.string().optional(),
    personName: z.string().optional(),
    personEmail: z.string().email().optional(),
    title: z.string(),
    status: z.string(),
    proposalSentAt: z.string().datetime().optional(),
    expectedResponseAt: z.string().datetime().optional(),
    externalUrl: z.string().url().optional()
  }),
  canonicalMeetingSchema
]);

export type CanonicalRecord = z.infer<typeof canonicalRecordSchema>;

/**
 * GTM-only integration boundary. Financial, accounting, project and post-sale
 * providers are deliberately absent; Trevra's own SaaS billing is separate platform infrastructure.
 *
 * The integration catalog is the single source of truth for what Trevra can connect to.
 *
 * `mode: 'oauth'` and `mode: 'apiKey'` both resolve their Nango integration id (provider config
 * key) from `process.env[env] ?? fallback`; they differ only in what the Nango Connect UI asks the
 * end user for. For `apiKey` the user pastes their provider key into the Connect UI, which posts it
 * straight to Nango — the raw key never reaches a Trevra process, is never rendered, logged, or
 * written to the database. Trevra stores only the connection reference returned on the auth webhook.
 * `mode: 'import'` has no live connection and uses its own key as an identifier.
 *
 * CRM integrations (HubSpot, Attio) are READ / sync only, deliberately.
 * Creating or updating a record in someone else's CRM is an `external-write` side effect, and every
 * external write in Trevra must go through prepareAction -> approveAction -> executeAction in
 * action-service.ts, where the exact approved payload is hashed and a drifted payload is rejected.
 * Wiring that up needs a new prepared-action type plus its schema, approval UI, and policy surface,
 * NOTE: CRM write-back now exists, but deliberately NOT here. It lives in
 * `crm/activity.ts` behind the `crm.log-activity` action type, because it
 * writes ACTIVITY rather than records and must never share a code path with
 * the record-owning providers below. `executeConnectedAction` still has no
 * hubspot/attio branch and falls through
 * to `throw new Error(\`Provider ${provider} cannot execute ${actionType}\`)`, so no ungated write
 * path exists. Do not add one without routing it through the approval gate first.
 *
 * APOLLO IS DELIBERATELY ABSENT, and must stay absent. Nango ships an `apollo` provider config, so
 * adding a row here would work -- but Apollo's Terms of Service, Section 3 (API Usage Requirements ->
 * Access and Integration), https://www.apollo.io/terms, read on 2026-07-27, state: "You may not
 * access the APIs via a third party's API credentials or integrate the Apollo APIs with your own
 * product or service." That clause is unqualified; the "internal tools ... not separately
 * commercialized" carve-out lives in the General Usage Restrictions and does not reach it. Shipping
 * an Apollo connection is exactly what it prohibits, whether Trevra is self-hosted or hosted.
 *
 * HUNTER IS NOT A ROW HERE EITHER, for a different reason. Its Terms of Service
 * (https://hunter.io/terms-of-service, last updated May 23, 2024, read 2026-10-06) allow "use of
 * the API through a third-party product that accesses the Services" (Section 4) but say "You must
 * not share your account with others" (Section 1), so it is bring-your-own-key per workspace, and
 * Nango's provider catalogue has no `hunter` entry. The key is sealed in workspace_secrets as
 * 'hunter_api_key'; the integration lives in src/server/enrichment/.
 */
const catalog = [
  {
    key: 'gmail',
    provider: 'gmail',
    name: 'Gmail',
    category: 'communication',
    description: 'Read client threads and send approved follow-ups.',
    mode: 'oauth',
    env: 'NANGO_GMAIL_INTEGRATION',
    fallback: 'trevra-gmail'
  },
  // Events become canonical meetings (src/server/meetings/google-calendar.ts).
  // Only events with someone already in the workspace are kept; internal,
  // personal and all-day events are counted as ignored, unreadable ones as skipped.
  {
    key: 'google-calendar',
    provider: 'google-calendar',
    name: 'Google Calendar',
    category: 'calendar',
    description:
      'Brings in meetings with people already in Trevra and moves their open Opportunity to Meeting. Internal, personal and all-day events are left out.',
    mode: 'oauth',
    env: 'NANGO_GOOGLE_CALENDAR_INTEGRATION',
    fallback: 'trevra-google-calendar'
  },
  {
    key: 'microsoft',
    provider: 'microsoft',
    name: 'Microsoft 365',
    category: 'communication',
    description: 'Connect Outlook mail and calendar through Microsoft Graph.',
    mode: 'oauth',
    env: 'NANGO_MICROSOFT_INTEGRATION',
    fallback: 'trevra-microsoft'
  },
  // Nango's built-in zoho-mail provider (OAuth2; the Connect UI asks for the
  // data-centre extension). Outreach only, from the approved mailbox, with the
  // reply-to-unsubscribe footer (src/server/email/unsubscribe-policy.ts).
  {
    key: 'zoho-mail',
    provider: 'zoho-mail',
    name: 'Zoho Mail',
    category: 'communication',
    description: 'Send approved outreach email from Zoho Mail and read replies into Conversations.',
    mode: 'oauth',
    env: 'NANGO_ZOHO_MAIL_INTEGRATION',
    fallback: 'trevra-zoho-mail'
  },
  {
    key: 'hubspot',
    provider: 'hubspot',
    name: 'HubSpot',
    category: 'crm',
    description:
      'Read your contacts, companies, and deals. Trevra adds a note when you approve work — it never creates or edits records.',
    mode: 'oauth',
    env: 'NANGO_HUBSPOT_INTEGRATION',
    fallback: 'trevra-hubspot'
  },
  {
    key: 'attio',
    provider: 'attio',
    name: 'Attio',
    category: 'crm',
    description:
      'Read your people, companies, and deals. Trevra adds a note when you approve work — it never creates or edits records.',
    mode: 'oauth',
    env: 'NANGO_ATTIO_INTEGRATION',
    fallback: 'trevra-attio'
  },
  // The key this connection stores in Nango is NOT what the search reads.
  // `research/providers/exa.ts` takes its key from the server environment
  // (`EXA_API_KEY`), so connecting here switches nothing on. Wiring the stored
  // credential through would mean threading the workspace's Nango connection
  // into the research credential map; until that exists the card says so.
  {
    key: 'exa',
    provider: 'exa',
    name: 'Exa',
    category: 'data',
    description:
      'Find companies worth reaching out to. Set up by whoever runs this Trevra — connecting here does not switch it on yet.',
    mode: 'apiKey',
    env: 'NANGO_EXA_INTEGRATION',
    fallback: 'trevra-exa'
  },
  {
    key: 'reddit',
    provider: 'reddit',
    name: 'Reddit',
    category: 'data',
    description:
      'Authorize a Reddit account through Nango, then collect reusable research sources and search the resulting corpus.',
    mode: 'oauth',
    env: 'NANGO_REDDIT_INTEGRATION',
    fallback: 'trevra-reddit'
  },
  {
    key: 'buffer',
    provider: 'buffer',
    name: 'Buffer',
    category: 'communication',
    description:
      'Create founder-approved social drafts in connected Buffer channels. Trevra never queues or publishes them automatically.',
    mode: 'apiKey',
    env: 'NANGO_BUFFER_INTEGRATION',
    fallback: 'trevra-buffer'
  },
  // Read-only and public: stars, forks and issues on repositories the owner
  // names in Setup, plus the public profiles of the people behind them. No
  // OAuth scopes are requested -- the token exists so polls spend the
  // connection's own rate limit instead of the 60/hour anonymous one. Trevra
  // never writes to GitHub. See src/server/github/poll.ts.
  {
    key: 'github',
    provider: 'github',
    name: 'GitHub',
    category: 'data',
    description:
      'Watch stars, forks and issues on your public repositories and match them to companies. Read-only — Trevra never writes to GitHub.',
    mode: 'oauth',
    env: 'NANGO_GITHUB_INTEGRATION',
    fallback: 'trevra-github'
  }
] as const;

type CatalogEntry = (typeof catalog)[number];

/** Every remaining integration is Nango-backed. */
function providerConfigKeyFor(item: CatalogEntry): string {
  return String(process.env[item.env] ?? item.fallback);
}

/** Integration ids the Connect UI may offer. Only GTM-relevant integrations are catalogued. */
export function defaultConnectSessionIntegrations(): string[] {
  return catalog.map(providerConfigKeyFor);
}

/** The Nango integration id GitHub connections are stored under. */
export function githubProviderConfigKey(): string {
  const entry = catalog.find((item) => item.key === 'github');
  if (!entry) throw new Error('GitHub is missing from the integration catalog');
  return providerConfigKeyFor(entry);
}

export async function listAvailableIntegrations(
  db: Db,
  workspaceId: string
): Promise<AvailableIntegration[]> {
  const connected = await db
    .prepare(
      "SELECT provider_config_key FROM connections WHERE workspace_id=? AND status='connected'"
    )
    .all<{ provider_config_key: string }>(workspaceId);
  const connectedKeys = new Set(connected.map((row) => row.provider_config_key));
  return catalog.map((item) => {
    const providerConfigKey = providerConfigKeyFor(item);
    return {
      key: providerConfigKey,
      provider: item.provider,
      name: item.name,
      category: item.category,
      description: item.description,
      mode: item.mode,
      connected: connectedKeys.has(providerConfigKey)
    };
  });
}

export async function createNangoConnectSession(input: {
  workspaceId: string;
  userId: string;
  userEmail: string;
  allowedIntegrations: string[];
}) {
  const nango = getNango();
  const supported = new Set(defaultConnectSessionIntegrations());
  const allowed =
    input.allowedIntegrations.length > 0
      ? input.allowedIntegrations.filter((integration) => supported.has(integration))
      : [...supported];
  if (allowed.length === 0) throw new Error('No supported integrations were requested.');
  const result = await nango.createConnectSession({
    allowed_integrations: allowed,
    tags: {
      end_user_id: input.userId,
      end_user_email: input.userEmail,
      organization_id: input.workspaceId,
      end_user_display_name: input.userEmail
    }
  });
  return {
    ...result.data,
    browser_host: process.env.NANGO_PUBLIC_SERVER_URL ?? process.env.NANGO_HOST
  };
}

export async function handleNangoWebhook(
  db: Db,
  rawBody: string,
  headers: Record<string, unknown>
): Promise<{ duplicate: boolean; processed: string }> {
  const nango = getNango();
  if (!nango.verifyIncomingWebhookRequest(rawBody, headers))
    throw new Error('Invalid Nango webhook signature');
  const payload = JSON.parse(rawBody) as Record<string, unknown>;
  const payloadHash = sha(rawBody);
  const externalEventId = String(
    payload.id ??
      payload.activityLogId ??
      `${payload.type}:${payload.operation ?? payload.syncName ?? ''}:${payloadHash}`
  );

  // RESOLVE THE TENANT, THEN CLAIM THE EVENT ID. Migration 058's idempotency
  // key includes the workspace, so a row recorded unattributed and later updated with its real
  // tenant vacates the `@unresolved` slot and the provider's next redelivery is
  // processed again. For a sync webhook that means re-ingesting a tenant's whole
  // record set; for an auth webhook it means re-upserting a connection.
  //
  // A failure to resolve is still recorded, in the sentinel bucket, before the
  // throw: an event nobody can attribute has no tenant slot to sit in, and
  // redeliveries of an unattributable event must still dedupe against each
  // other rather than piling up rows.
  let workspaceId: string | null = null;
  let connection: Record<string, unknown> | undefined;
  try {
    if (payload.type === 'auth') {
      const tags = (payload.tags ?? {}) as Record<string, unknown>;
      workspaceId = String(tags.organization_id ?? '') || null;
      if (!workspaceId) throw new Error('Nango auth webhook is missing organization_id tag');
    } else if (payload.type === 'sync' && payload.success === true) {
      connection = await resolveNangoConnection(
        db,
        String(payload.providerConfigKey),
        String(payload.connectionId)
      );
      workspaceId = String(connection.workspace_id);
    } else if (
      payload.type === 'sync' &&
      payload.success === false &&
      payload.syncName === INBOUND_SYNC_NAME
    ) {
      // A failure webhook for an unknown or ambiguous connection stays ignored,
      // as every failed sync webhook was before it could close a designation.
      connection = await resolveNangoConnection(
        db,
        String(payload.providerConfigKey),
        String(payload.connectionId)
      ).catch((error: unknown) => {
        // Only "no such connection" and "several workspaces" are ignorable.
        if (
          error instanceof Error &&
          (error.message === 'Unknown Nango connection' ||
            error.message.includes('is registered in'))
        )
          return undefined;
        throw error;
      });
      workspaceId = connection ? String(connection.workspace_id) : null;
    }
  } catch (error) {
    if (await recordWebhook(db, 'nango', externalEventId, null, payloadHash)) {
      await completeWebhook(
        db,
        'nango',
        externalEventId,
        'failed',
        error instanceof Error ? error.message : String(error),
        null
      );
    }
    throw error;
  }

  const inserted = await recordWebhook(db, 'nango', externalEventId, workspaceId, payloadHash);
  if (!inserted) return { duplicate: true, processed: 'duplicate' };

  try {
    if (payload.type === 'auth') {
      const tags = (payload.tags ?? {}) as Record<string, unknown>;
      const success = payload.success !== false;
      const now = new Date().toISOString();
      const providerConfigKey = String(payload.providerConfigKey);
      const connectionId = String(payload.connectionId);
      const existing = (await db
        .prepare(
          'SELECT id,status FROM connections WHERE workspace_id=? AND provider_config_key=? AND external_connection_id=?'
        )
        .get(workspaceId, providerConfigKey, connectionId)) as
        { id: string; status: string } | undefined;
      const localId = existing?.id ?? id('conn');
      await db
        .prepare(
          `
        INSERT INTO connections (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,last_error,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(workspace_id,provider_config_key,external_connection_id) DO UPDATE SET
          provider=excluded.provider,display_name=excluded.display_name,status=excluded.status,last_error=excluded.last_error,updated_at=excluded.updated_at,
          mailbox_address=NULL
      `
        )
        .run(
          localId,
          workspaceId,
          String(payload.provider ?? providerConfigKey),
          providerConfigKey,
          connectionId,
          tags.end_user_email ? String(tags.end_user_email) : null,
          success ? 'connected' : 'needs_reauth',
          0,
          success ? null : JSON.stringify(payload.error ?? 'Connection failed'),
          now,
          now
        );
      await completeWebhook(db, 'nango', externalEventId, 'processed', null, workspaceId);
      if (!success && existing?.status !== 'needs_reauth') {
        try {
          const providerError = typeof payload.error === 'string' ? payload.error : '';
          const reason = /expired|invalid_grant|revoked/i.test(providerError)
            ? 'The provider authorization expired or was revoked.'
            : /denied|unauthori[sz]ed|forbidden/i.test(providerError)
              ? 'The provider rejected the authorization.'
              : 'The provider authorization could not be refreshed.';
          await notifyIntegrationNeedsReauth(db, {
            workspaceId: String(workspaceId),
            provider: String(payload.provider ?? providerConfigKey),
            accountLabel: tags.end_user_email ? String(tags.end_user_email) : null,
            reason
          });
        } catch (notificationError) {
          console.error(
            'Failed to deliver Trevra integration reauthorization notification',
            notificationError
          );
        }
      }
      return {
        duplicate: false,
        processed: success ? 'connection-upserted' : 'connection-needs-reauth'
      };
    }

    if (
      payload.type === 'sync' &&
      payload.success === false &&
      payload.syncName === INBOUND_SYNC_NAME &&
      connection
    ) {
      // Only the designated mailbox's own row. Content-free text: nothing from
      // the payload is stored.
      await db
        .prepare(
          `UPDATE email_inbound_mailboxes SET sync_status='unavailable',sync_error=?,updated_at=?::timestamptz
           WHERE workspace_id=? AND connection_id=?`
        )
        .run(
          INBOUND_SYNC_FAILED_ERROR,
          new Date().toISOString(),
          String(connection.workspace_id),
          String(connection.id)
        );
      await completeWebhook(
        db,
        'nango',
        externalEventId,
        'processed',
        null,
        String(connection.workspace_id)
      );
      return { duplicate: false, processed: 'inbound-sync-failed' };
    }

    if (payload.type === 'sync' && payload.success === true && connection) {
      const connectionId = String(payload.connectionId);
      const providerConfigKey = String(payload.providerConfigKey);
      const synced = await syncNangoRecords(db, {
        workspaceId: String(connection.workspace_id),
        localConnectionId: String(connection.id),
        provider: String(connection.provider),
        providerConfigKey,
        externalConnectionId: connectionId,
        model: String(payload.model),
        modifiedAfter: payload.modifiedAfter ? String(payload.modifiedAfter) : undefined
      });
      // A sync that threw records away is not a clean sync, and reporting one
      // is how a connection that stores nothing goes unnoticed for months.
      const dropped =
        synced.skipped > 0
          ? `${synced.skipped} record${synced.skipped === 1 ? '' : 's'} from '${String(payload.model)}' could not be read and ${synced.skipped === 1 ? 'was' : 'were'} not stored.`
          : null;
      await db
        .prepare(
          "UPDATE connections SET status='connected',last_synced_at=?,last_error=?,updated_at=? WHERE id=?"
        )
        .run(new Date().toISOString(), dropped, new Date().toISOString(), String(connection.id));
      if (payload.syncName === INBOUND_SYNC_NAME) {
        // Recovery half of the failure closer: one transient failure must not stick.
        await db
          .prepare(
            `UPDATE email_inbound_mailboxes SET sync_status='syncing',sync_error=NULL,updated_at=?::timestamptz
             WHERE workspace_id=? AND connection_id=?`
          )
          .run(new Date().toISOString(), String(connection.workspace_id), String(connection.id));
      }
      await completeWebhook(
        db,
        'nango',
        externalEventId,
        'processed',
        null,
        String(connection.workspace_id)
      );
      return {
        duplicate: false,
        processed: `synced-${synced.ingested}${synced.skipped > 0 ? `-skipped-${synced.skipped}` : ''}${synced.ignored > 0 ? `-ignored-${synced.ignored}` : ''}`
      };
    }

    await completeWebhook(db, 'nango', externalEventId, 'ignored', null, workspaceId);
    return { duplicate: false, processed: 'ignored' };
  } catch (error) {
    await completeWebhook(
      db,
      'nango',
      externalEventId,
      'failed',
      error instanceof Error ? error.message : String(error),
      workspaceId
    );
    throw error;
  }
}

/**
 * WHICH TENANT'S RECORDS ARE THESE?
 *
 * A Nango sync webhook names an integration and a connection, never a workspace
 * -- only the auth webhook carries the `organization_id` tag. The workspace
 * therefore has to come from the `connections` row, and this lookup used to take
 * whatever row the database returned first: no `workspace_id` in the predicate
 * and no LIMIT. `connections` is UNIQUE(workspace_id, provider_config_key,
 * external_connection_id) (001:45), so the same provider/connection pair in two
 * workspaces is a perfectly legal pair of rows, and the arbitrary winner's
 * `workspace_id` was then handed to `syncNangoRecords` -- filing one tenant's
 * GTM records into another tenant's account, silently and
 * permanently.
 *
 * Nango's own connection ids are unique per integration, so more than one row
 * here means the local data is wrong, not that a choice has to be made. Refuse:
 * a sync that stops is recoverable, a sync that guesses is a cross-tenant data
 * leak nobody notices. The offending rows are visible with a single query on
 * `connections`, so the message stays free of workspace ids -- this error is
 * returned to the webhook caller.
 *
 * Not fixed with a UNIQUE index on (provider_config_key, external_connection_id):
 * an existing deployment may already hold the duplicates this refusal is about,
 * and a migration that either fails or silently deletes one of a customer's
 * connections is worse than the refusal.
 */
async function resolveNangoConnection(
  db: Db,
  providerConfigKey: string,
  connectionId: string
): Promise<Record<string, unknown>> {
  const candidates = await db
    .prepare(
      'SELECT * FROM connections WHERE provider_config_key=? AND external_connection_id=? ORDER BY workspace_id ASC'
    )
    .all<Record<string, unknown>>(providerConfigKey, connectionId);
  if (candidates.length === 0) throw new Error('Unknown Nango connection');
  if (candidates.length > 1) {
    throw new Error(
      `Nango connection ${providerConfigKey}/${connectionId} is registered in ${candidates.length} workspaces; refusing to guess which tenant these records belong to`
    );
  }
  return candidates[0]!;
}

export async function triggerConnectionSync(
  db: Db,
  workspaceId: string,
  localConnectionId: string
): Promise<void> {
  const connection = (await db
    .prepare('SELECT * FROM connections WHERE id=? AND workspace_id=? AND is_demo=0')
    .get(localConnectionId, workspaceId)) as Record<string, unknown> | undefined;
  if (!connection) throw new Error('Live connection not found');
  const syncNames = syncNamesForProvider(String(connection.provider));
  if (syncNames.length === 0) throw new Error('No sync functions configured for this provider');
  await getNango().triggerSync(
    String(connection.provider_config_key),
    syncNames,
    String(connection.external_connection_id)
  );
}

export async function disconnectIntegration(
  db: Db,
  workspaceId: string,
  localConnectionId: string
): Promise<void> {
  const connection = (await db
    .prepare('SELECT * FROM connections WHERE id=? AND workspace_id=?')
    .get(localConnectionId, workspaceId)) as Record<string, unknown> | undefined;
  if (!connection) throw new Error('Connection not found');
  if (!Boolean(connection.is_demo))
    await getNango().deleteConnection(
      String(connection.provider_config_key),
      String(connection.external_connection_id)
    );
  await db
    .prepare("UPDATE connections SET status='disconnected',updated_at=? WHERE id=?")
    .run(new Date().toISOString(), localConnectionId);
  // A disconnected mailbox cannot be read; Nango deleted its syncs with the connection.
  await db
    .prepare('DELETE FROM email_inbound_mailboxes WHERE workspace_id=? AND connection_id=?')
    .run(workspaceId, localConnectionId);
}

/** A pre-provider campaign-email refusal with a known, non-unknown outcome. */
export class CampaignEmailSendRefusal extends Error {
  constructor(
    public readonly scope: 'recipient' | 'workspace',
    message: string
  ) {
    super(message);
  }
}

export async function executeConnectedAction(
  db: Db,
  workspaceId: string,
  action: Record<string, unknown>
): Promise<{ provider: string; externalRef: string }> {
  const actionType = String(action.type);
  if (actionType !== 'email_draft') {
    throw new Error(`Unsupported connected action type: ${actionType}`);
  }
  const recipient = String(action.recipient ?? '').trim();
  if (!recipient) throw new Error('Email action requires recipient.');
  const structuredPayload = JSON.parse(String(action.structured_payload_json ?? '{}')) as Record<
    string,
    unknown
  >;
  const campaignSend = structuredPayload.deliverySourceType === 'campaign_email';
  if (campaignSend) {
    // Even after the campaign worker's checks, contact state can change during
    // mailbox/DNS checks. Re-read it at the shared provider boundary.
    const contactId =
      typeof structuredPayload.contactId === 'string' ? structuredPayload.contactId : '';
    const personId =
      typeof structuredPayload.personId === 'string' ? structuredPayload.personId : '';
    if (!contactId || !personId)
      throw new CampaignEmailSendRefusal(
        'recipient',
        'Campaign email has no bound Person and contact identity.'
      );
    const contact = await db
      .prepare(
        'SELECT person_id,email,do_not_contact FROM linkedin_lead_contacts WHERE workspace_id=? AND id=?'
      )
      .get<{ person_id: string | null; email: string | null; do_not_contact: boolean }>(
        workspaceId,
        contactId
      );
    if (
      !contact ||
      contact.do_not_contact ||
      contact.person_id !== personId ||
      contact.email?.trim().toLowerCase() !== recipient.toLowerCase()
    )
      throw new CampaignEmailSendRefusal(
        'recipient',
        'Campaign recipient identity or reachability changed; nothing sent.'
      );
    try {
      await assertNotSuppressed(db, workspaceId, { channel: 'email', email: recipient, personId });
    } catch (error) {
      if (!(error instanceof SuppressionError)) throw error;
      throw new CampaignEmailSendRefusal(
        'recipient',
        'Campaign recipient is suppressed; nothing sent.'
      );
    }
  } else {
    // Every legacy, reply and playbook path still reaches the email suppression.
    await assertNotSuppressed(db, workspaceId, { channel: 'email', email: recipient });
  }

  // A required (approval-bound) connection must still be the live, provider-
  // verified mailbox; re-authorization clears mailbox_address.
  const requiredMailbox =
    action.require_connection_id === true
      ? " AND is_demo=0 AND provider IN ('gmail','google-mail','microsoft','outlook','zoho-mail') AND mailbox_address IS NOT NULL"
      : '';
  let connection = action.connection_id
    ? ((await db
        .prepare(
          `SELECT * FROM connections WHERE id=? AND workspace_id=? AND status='connected'${requiredMailbox}`
        )
        .get(String(action.connection_id), workspaceId)) as Record<string, unknown> | undefined)
    : undefined;
  if (!connection && action.require_connection_id === true) {
    // An approval bound to one mailbox never falls back to another one.
    throw Object.assign(
      new Error(
        'The mailbox this email was approved to send from is not connected; nothing was sent.'
      ),
      { status: 409 }
    );
  }
  if (!connection) {
    // Zoho Mail is deliberately absent: it sends only outreach bound to it by
    // approval (require_connection_id), never as the newest-mailbox fallback
    // for campaign, skill or legacy sends that expect List-Unsubscribe or threading.
    connection = (await db
      .prepare(
        "SELECT * FROM connections WHERE workspace_id=? AND status='connected' AND provider IN ('gmail','google-mail','microsoft','outlook') ORDER BY is_demo ASC,updated_at DESC LIMIT 1"
      )
      .get(workspaceId)) as Record<string, unknown> | undefined;
  }
  if (!connection) {
    const settings = await db
      .prepare('SELECT demo_mode FROM workspace_settings WHERE workspace_id=?')
      .get<{ demo_mode?: number }>(workspaceId);
    if (Boolean(settings?.demo_mode)) {
      connection = await db
        .prepare(
          "SELECT * FROM connections WHERE workspace_id=? AND is_demo=1 AND status='connected' ORDER BY updated_at DESC LIMIT 1"
        )
        .get<Record<string, unknown>>(workspaceId);
    }
  }
  if (!connection) throw new Error('Connect Gmail or Microsoft 365 before executing this action');

  const provider = String(connection.provider);
  const providerConfigKey = String(connection.provider_config_key);
  const connectionId = String(connection.external_connection_id);
  const idempotencyKey = String(action.payload_hash ?? '').trim();
  if (!idempotencyKey) throw new Error('Email action requires an idempotency key.');
  const purpose =
    structuredPayload.deliveryPurpose === 'reply' || structuredPayload.deliveryPurpose === 'other'
      ? structuredPayload.deliveryPurpose
      : ('outreach' as const);
  if (campaignSend) {
    const actualAddress = String(connection.mailbox_address ?? '')
      .trim()
      .toLowerCase();
    const approvedAddress =
      typeof structuredPayload.senderAddress === 'string'
        ? structuredPayload.senderAddress.trim().toLowerCase()
        : '';
    if (
      action.require_connection_id !== true ||
      !actualAddress ||
      !approvedAddress ||
      actualAddress !== approvedAddress
    )
      throw new CampaignEmailSendRefusal(
        'workspace',
        'The selected campaign mailbox identity changed; nothing sent.'
      );
  }
  const sourceType =
    typeof structuredPayload.deliverySourceType === 'string' &&
    structuredPayload.deliverySourceType.trim()
      ? structuredPayload.deliverySourceType.trim()
      : 'email_action';
  const sourceId =
    typeof structuredPayload.deliverySourceId === 'string' &&
    structuredPayload.deliverySourceId.trim()
      ? structuredPayload.deliverySourceId.trim()
      : idempotencyKey;
  const requireListUnsubscribe = structuredPayload.requireListUnsubscribe === true;
  const unsubscribeMode = parseOutreachUnsubscribeMode(structuredPayload.unsubscribeMode);
  if (campaignSend) {
    if (
      purpose !== 'outreach' ||
      !requireListUnsubscribe ||
      unsubscribeMode !== 'list_unsubscribe_headers'
    )
      throw new CampaignEmailSendRefusal(
        'workspace',
        'Campaign outreach must include RFC8058 one-click unsubscribe headers; nothing sent.'
      );
    const footer = (await emailComplianceProvider().footer(db, workspaceId))?.trim() ?? '';
    if (
      !footer ||
      !footer.endsWith(OUTREACH_OPT_OUT_SENTENCE) ||
      !String(action.body ?? '')
        .trimEnd()
        .endsWith(footer)
    )
      throw new CampaignEmailSendRefusal(
        'workspace',
        'The campaign compliance footer changed or is missing; nothing sent.'
      );
  }
  // The one provider-aware unsubscribe decision (src/server/email/unsubscribe-policy.ts),
  // enforced before any delivery row so a refusal leaves nothing to retry.
  assertUnsubscribeModeAllowed({
    provider,
    purpose,
    requireListUnsubscribe,
    unsubscribeMode
  });
  // Reply-to-unsubscribe is reachable only from approved email outreach, never
  // from a campaign, skill or legacy send that claims the mode in its payload.
  if (
    unsubscribeMode === 'footer_and_reply' &&
    (sourceType !== 'email_outreach' || structuredPayload.intent !== 'email-outreach')
  ) {
    throw new UnsubscribePolicyError(
      'Reply-to-unsubscribe is allowed only for approved email outreach; nothing was sent.'
    );
  }
  if (mailProviderFor(provider) === 'zoho') {
    // Defence in depth: the unbound fallback never picks Zoho, and a Zoho email
    // must carry the opt-out line its footer_and_reply approval promised.
    if (action.require_connection_id !== true) {
      throw new ZohoMailError(
        'Zoho Mail sends only outreach bound to it by approval; nothing was sent.'
      );
    }
    if (
      !String(action.body ?? '')
        .trimEnd()
        .endsWith(OUTREACH_REPLY_OPT_OUT_SENTENCE)
    ) {
      throw new ZohoMailError(
        'This Zoho Mail outreach does not end with the reply-to-unsubscribe line; nothing was sent. Prepare it again.'
      );
    }
  }
  const localConnectionId = String(connection.id);
  const claimed = await claimEmailDelivery(db, {
    workspaceId,
    connectionId: localConnectionId,
    purpose,
    recipient,
    sourceType,
    sourceId,
    idempotencyKey
  });
  if (claimed.replayed) {
    if (!claimed.delivery.provider || !claimed.delivery.externalRef)
      throw new Error('Stored sent email delivery is missing its provider result.');
    return {
      provider: claimed.delivery.provider,
      externalRef: claimed.delivery.externalRef
    };
  }
  const deliveryId = claimed.delivery.id;
  try {
    await assertEmailDeliveryCapacity(db, {
      workspaceId,
      connectionId: localConnectionId,
      purpose,
      excludeDeliveryId: deliveryId
    });
  } catch (error) {
    await markEmailDeliveryFailure(db, deliveryId, error);
    throw error;
  }
  if (Boolean(connection.is_demo)) {
    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_SIMULATED_EXECUTION !== 'true') {
      const error = new Error('A live provider connection is required in production');
      await markEmailDeliveryFailure(db, deliveryId, error);
      throw error;
    }
    const outcome = {
      provider: 'simulation',
      externalRef: `sim_${id('delivery')}`,
      internetMessageId: `<${idempotencyKey}@trevra.app>`
    };
    await markEmailDeliverySent(db, deliveryId, outcome);
    return { provider: outcome.provider, externalRef: outcome.externalRef };
  }
  // RFC 8058 one-click unsubscribe on every email approved with it (Phase D
  // outreach). Every other send, campaign and legacy outreach included, keeps
  // its pre-Phase-D path: no List-Unsubscribe header and Graph's JSON send. The
  // token is bound to this delivery's stable id, so a retry of a failed delivery
  // carries the same link. Anything going wrong here happens before any
  // provider call, so it is reported as a definite (4xx) failure and the
  // delivery stays retryable.
  let unsubscribeHeaders: string[] = [];
  if (requireListUnsubscribe && purpose === 'outreach') {
    try {
      unsubscribeHeaders = await outreachUnsubscribeHeaders(db, {
        workspaceId,
        deliveryId,
        recipient
      });
    } catch (error) {
      const wrapped = Object.assign(
        new Error(
          `Unsubscribe headers could not be prepared: ${error instanceof Error ? error.message : String(error)}`
        ),
        { status: 400 }
      );
      await markEmailDeliveryFailure(db, deliveryId, wrapped);
      throw wrapped;
    }
  }
  if (requireListUnsubscribe && unsubscribeHeaders.length === 0) {
    const error = Object.assign(
      new Error(
        purpose === 'outreach'
          ? 'This email was approved with a one-click unsubscribe link, but this deployment has no HTTPS public origin (TREVRA_PUBLIC_API_URL) or TREVRA_SECRETS_KEY; nothing was sent.'
          : 'This email requires a one-click unsubscribe link, but unsubscribe headers apply only to outreach sends; nothing was sent.'
      ),
      { status: 409 }
    );
    await markEmailDeliveryFailure(db, deliveryId, error);
    throw error;
  }
  const nango = getNango();

  const threadExternalRef =
    structuredPayload.threaded === true && typeof structuredPayload.threadExternalRef === 'string'
      ? structuredPayload.threadExternalRef.trim()
      : '';
  const threadIdempotencyKey =
    structuredPayload.threaded === true &&
    typeof structuredPayload.threadIdempotencyKey === 'string'
      ? structuredPayload.threadIdempotencyKey.trim()
      : '';
  const htmlBody =
    typeof structuredPayload.htmlBody === 'string' && structuredPayload.htmlBody.trim()
      ? structuredPayload.htmlBody
      : '';

  try {
    if (provider === 'microsoft' || provider === 'outlook') {
      if (requireListUnsubscribe) {
        // Graph's JSON message API accepts only x- custom headers, so the RFC
        // 8058 List-Unsubscribe headers need Graph's MIME send. A follow-up
        // threads by In-Reply-To/References to the prior delivery's recorded
        // Message-ID instead of createReply.
        let inReplyTo: string | null = null;
        if (threadIdempotencyKey) {
          const prior = await db
            .prepare(
              'SELECT internet_message_id FROM gtm_deliveries WHERE workspace_id=? AND idempotency_key=?'
            )
            .get<{ internet_message_id: string | null }>(workspaceId, threadIdempotencyKey);
          inReplyTo = prior?.internet_message_id?.trim() || `<${threadIdempotencyKey}@trevra.app>`;
        }
        const mime = buildMimeMessage({
          recipient,
          subject: String(action.subject),
          body: String(action.body),
          idempotencyKey,
          inReplyTo,
          htmlBody: htmlBody || null,
          extraHeaders: unsubscribeHeaders
        });
        const mimeDraft = await nango.post<{ id?: string; internetMessageId?: string }>({
          endpoint: '/v1.0/me/messages',
          providerConfigKey,
          connectionId,
          retries: 0,
          headers: { 'Content-Type': 'text/plain' },
          data: Buffer.from(mime).toString('base64')
        });
        const mimeDraftId = String(mimeDraft.data.id ?? '').trim();
        if (!mimeDraftId) throw new Error('Microsoft MIME draft returned no message id.');
        await nango.post({
          endpoint: `/v1.0/me/messages/${encodeURIComponent(mimeDraftId)}/send`,
          providerConfigKey,
          connectionId,
          retries: 0
        });
        const outcome = {
          provider: 'microsoft',
          externalRef: mimeDraftId,
          internetMessageId: mimeDraft.data.internetMessageId ?? null
        };
        await markEmailDeliverySent(db, deliveryId, outcome);
        return { provider: outcome.provider, externalRef: outcome.externalRef };
      }
      if (threadExternalRef) {
        const replyDraft = await nango.post<{ id?: string; internetMessageId?: string }>({
          endpoint: `/v1.0/me/messages/${encodeURIComponent(threadExternalRef)}/createReply`,
          providerConfigKey,
          connectionId,
          retries: 0,
          data: {
            message: {
              body: {
                contentType: htmlBody ? 'HTML' : 'Text',
                content: htmlBody || String(action.body)
              }
            }
          }
        });
        const replyId = String(replyDraft.data.id ?? '').trim();
        if (!replyId) throw new Error('Microsoft reply draft returned no message id.');
        await nango.post({
          endpoint: `/v1.0/me/messages/${encodeURIComponent(replyId)}/send`,
          providerConfigKey,
          connectionId,
          retries: 0
        });
        const outcome = {
          provider: 'microsoft',
          externalRef: replyId,
          internetMessageId: replyDraft.data.internetMessageId ?? null
        };
        await markEmailDeliverySent(db, deliveryId, outcome);
        return { provider: outcome.provider, externalRef: outcome.externalRef };
      }

      const draft = await nango.post<{ id?: string; internetMessageId?: string }>({
        endpoint: '/v1.0/me/messages',
        providerConfigKey,
        connectionId,
        retries: 0,
        data: {
          subject: String(action.subject),
          body: {
            contentType: htmlBody ? 'HTML' : 'Text',
            content: htmlBody || String(action.body)
          },
          toRecipients: [{ emailAddress: { address: String(action.recipient) } }],
          internetMessageHeaders: [
            { name: 'x-trevra-idempotency-key', value: String(action.payload_hash) }
          ]
        }
      });
      const draftId = String(draft.data.id ?? '').trim();
      if (!draftId) throw new Error('Microsoft message draft returned no message id.');
      await nango.post({
        endpoint: `/v1.0/me/messages/${encodeURIComponent(draftId)}/send`,
        providerConfigKey,
        connectionId,
        retries: 0
      });
      const outcome = {
        provider: 'microsoft',
        externalRef: draftId,
        internetMessageId: draft.data.internetMessageId ?? null
      };
      await markEmailDeliverySent(db, deliveryId, outcome);
      return { provider: outcome.provider, externalRef: outcome.externalRef };
    }

    if (mailProviderFor(provider) === 'zoho') {
      // Zoho sends only plain first-touch outreach approved in footer_and_reply
      // mode (checked above). No threading: its Message-ID cannot be set and a
      // follow-up could not thread reliably.
      if (threadExternalRef || threadIdempotencyKey || htmlBody) {
        throw new ZohoMailError(
          'Zoho Mail sends only plain first-touch outreach from Trevra; this email asks for threading or HTML, so nothing was sent.'
        );
      }
      const zohoConnection = { providerConfigKey, connectionId };
      let account: Awaited<ReturnType<typeof readZohoAccount>>;
      try {
        account = await readZohoAccount(nango, zohoConnection);
      } catch (error) {
        // Nothing has been sent yet, so this is a definite, retryable failure.
        throw error instanceof ZohoMailError
          ? error
          : new ZohoMailError(
              `Trevra could not confirm which Zoho Mail account this connection sends as; nothing was sent. ${error instanceof Error ? error.message : String(error)}`
            );
      }
      const approvedAddress = String(connection.mailbox_address ?? '')
        .trim()
        .toLowerCase();
      if (!approvedAddress || account.address !== approvedAddress) {
        throw new ZohoMailError(
          'This Zoho Mail connection now sends as a different address than the approved mailbox; nothing was sent. Reconnect it and prepare the email again.'
        );
      }
      const sent = await sendZohoMessage(nango, zohoConnection, {
        accountId: account.accountId,
        fromAddress: approvedAddress,
        toAddress: recipient,
        subject: String(action.subject),
        content: String(action.body)
      });
      const outcome = {
        provider: ZOHO_MAIL_PROVIDER,
        externalRef: sent.messageId ?? id('zoho'),
        // Zoho writes its own Message-ID. Without the read-back there is no id
        // to thread on, and an unthreaded opt-out reply still suppresses
        // (src/server/email/inbound-mailbox.ts).
        internetMessageId: sent.messageId
          ? await readZohoSentMessageId(nango, zohoConnection, {
              accountId: account.accountId,
              messageId: sent.messageId
            })
          : null
      };
      await markEmailDeliverySent(db, deliveryId, outcome);
      return { provider: outcome.provider, externalRef: outcome.externalRef };
    }
    if (!['gmail', 'google-mail'].includes(provider))
      throw new Error(`Provider ${provider} cannot execute ${actionType}`);
    let threadId = '';
    if (threadExternalRef) {
      const previous = await nango.get<{ threadId?: string }>({
        endpoint: `/gmail/v1/users/me/messages/${encodeURIComponent(threadExternalRef)}`,
        providerConfigKey,
        connectionId,
        retries: 3,
        params: { format: 'minimal' }
      });
      threadId = String(previous.data.threadId ?? '').trim();
      if (!threadId) throw new Error('Gmail previous message returned no thread id.');
    }
    const raw = Buffer.from(
      buildMimeMessage({
        recipient,
        subject: String(action.subject),
        body: String(action.body),
        idempotencyKey,
        inReplyTo: threadIdempotencyKey ? `<${threadIdempotencyKey}@trevra.app>` : null,
        htmlBody: htmlBody || null,
        extraHeaders: unsubscribeHeaders
      })
    ).toString('base64url');
    const response = await nango.post<{ id?: string; threadId?: string }>({
      endpoint: '/gmail/v1/users/me/messages/send',
      providerConfigKey,
      connectionId,
      retries: 0,
      data: { raw, ...(threadId ? { threadId } : {}) }
    });
    const gmailMessageId = String(response.data.id ?? '').trim();
    const outcome = {
      provider: 'gmail',
      externalRef: gmailMessageId || id('gmail'),
      internetMessageId:
        (gmailMessageId
          ? await readGmailMessageIdHeader(nango, {
              providerConfigKey,
              connectionId,
              messageId: gmailMessageId
            })
          : null) ?? `<${idempotencyKey}@trevra.app>`
    };
    await markEmailDeliverySent(db, deliveryId, outcome);
    return { provider: outcome.provider, externalRef: outcome.externalRef };
  } catch (error) {
    await markEmailDeliveryFailure(db, deliveryId, error);
    throw error;
  }
}

/** Upper bound on the post-send Message-ID read; the send has already happened. */
export const GMAIL_MESSAGE_ID_READ_TIMEOUT_MS = 5_000;

/**
 * One RFC 5322 msg-id, normalised exactly as the inbound-messages sync
 * normalises In-Reply-To/References (nango-integrations/shared/inbound-email.ts
 * parseMessageIds + its 998-char bound), so a threaded reply compares equal.
 */
function normalizedMessageId(value: string): string | null {
  const match = /<[^<>\s]+>/.exec(value);
  return match ? match[0].slice(0, 998) : null;
}

/**
 * Gmail may replace the Message-ID Trevra wrote, so replies thread to the id
 * Gmail actually sent. Read it back once after a successful send. Any failure
 * or timeout returns null and the caller keeps the generated id: the email has
 * already left, so this must never fail or retry the send.
 *
 * lc-debt: a timed-out read is abandoned, not aborted (the Nango SDK proxy takes
 * no AbortSignal); upgrade path is passing an AbortSignal once the SDK accepts one.
 */
async function readGmailMessageIdHeader(
  nango: ReturnType<typeof getNango>,
  input: { providerConfigKey: string; connectionId: string; messageId: string }
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), GMAIL_MESSAGE_ID_READ_TIMEOUT_MS);
    });
    const read = nango
      .get<{ payload?: { headers?: Array<{ name?: string; value?: string }> } }>({
        endpoint: `/gmail/v1/users/me/messages/${encodeURIComponent(input.messageId)}`,
        providerConfigKey: input.providerConfigKey,
        connectionId: input.connectionId,
        retries: 0,
        params: { format: 'metadata', metadataHeaders: 'Message-ID' }
      })
      .then((response) =>
        normalizedMessageId(headerValue(response.data?.payload?.headers, 'Message-ID'))
      );
    // A late rejection after the timeout won must not become unhandled.
    read.catch(() => undefined);
    return await Promise.race([read, timedOut]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface ConnectedEmailThreadEvent {
  kind: VerifiedEmailOutcome;
  providerEventId: string;
  occurredAt?: string;
  subject?: string;
  sender?: string;
  /** Present only when the provider returned verified message content. */
  body?: string;
}

function headerValue(
  headers: Array<{ name?: string; value?: string }> | undefined,
  name: string
): string {
  return (
    headers?.find((header) => String(header.name ?? '').toLowerCase() === name.toLowerCase())
      ?.value ?? ''
  );
}

function addressFromHeader(value: string): string {
  const bracketed = value.match(/<([^>]+)>/)?.[1];
  const raw = bracketed ?? value;
  return raw
    .trim()
    .toLowerCase()
    .replace(/^mailto:/, '');
}

function bounceLike(from: string, subject: string): boolean {
  return (
    /(?:mailer-daemon|postmaster|mail delivery subsystem|microsoft outlook)/i.test(from) ||
    /^(?:delivery status notification|undeliverable|delivery has failed|mail delivery failed)/i.test(
      subject.trim()
    )
  );
}

interface GmailMessagePayload {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailMessagePayload[];
  headers?: Array<{ name?: string; value?: string }>;
}

function decodeBase64UrlText(value: string | undefined): string {
  if (!value) return '';
  try {
    return Buffer.from(value, 'base64url').toString('utf8').trim();
  } catch {
    return '';
  }
}

function plainTextFromHtml(value: string): string {
  return value
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim();
}

function gmailPayloadText(payload: GmailMessagePayload | undefined): string {
  if (!payload) return '';
  if (payload.mimeType?.toLowerCase().startsWith('text/plain')) {
    const text = decodeBase64UrlText(payload.body?.data);
    if (text) return text;
  }
  for (const part of payload.parts ?? []) {
    if (!part.mimeType?.toLowerCase().startsWith('text/plain')) continue;
    const text = gmailPayloadText(part);
    if (text) return text;
  }
  for (const part of payload.parts ?? []) {
    const text = gmailPayloadText(part);
    if (text) return text;
  }
  const raw = decodeBase64UrlText(payload.body?.data);
  if (!raw) return '';
  return payload.mimeType?.toLowerCase().startsWith('text/html') ? plainTextFromHtml(raw) : raw;
}

function providerBodyText(contentType: string | undefined, content: string | undefined): string {
  const raw = content?.trim() ?? '';
  if (!raw) return '';
  return contentType?.toLowerCase() === 'html' ? plainTextFromHtml(raw) : raw;
}
/**
 * Re-read the provider thread for one Trevra-sent campaign email.
 *
 * Gmail and Microsoft do not expose reliable open/click state from the mailbox API;
 * those are recorded by Trevra's opt-in tracking endpoints. They do expose the
 * conversation, which is the authoritative place to learn that the recipient replied.
 * Common delivery-status messages are also recognised as bounces when they are visible
 * in the same provider conversation. Every returned provider message id becomes the
 * idempotency key of the campaign event, so polling is safe.
 */
export async function readConnectedEmailThreadEvents(
  db: Db,
  workspaceId: string,
  input: {
    localConnectionId: string;
    externalRef: string;
    recipient: string;
  }
): Promise<ConnectedEmailThreadEvent[]> {
  const connection = (await db
    .prepare("SELECT * FROM connections WHERE id=? AND workspace_id=? AND status='connected'")
    .get(input.localConnectionId, workspaceId)) as Record<string, unknown> | undefined;
  if (!connection || Boolean(connection.is_demo)) return [];

  const provider = String(connection.provider);
  const providerConfigKey = String(connection.provider_config_key);
  const connectionId = String(connection.external_connection_id);
  const recipient = input.recipient.trim().toLowerCase();
  if (!recipient || !input.externalRef.trim()) return [];
  const nango = getNango();

  if (provider === 'gmail' || provider === 'google-mail') {
    const sent = await nango.get<{ threadId?: string }>({
      endpoint: `/gmail/v1/users/me/messages/${encodeURIComponent(input.externalRef)}`,
      providerConfigKey,
      connectionId,
      retries: 3,
      params: { format: 'minimal' }
    });
    const threadId = String(sent.data.threadId ?? '').trim();
    if (!threadId) return [];
    const thread = await nango.get<{
      messages?: Array<{
        id?: string;
        internalDate?: string;
        labelIds?: string[];
        payload?: GmailMessagePayload;
      }>;
    }>({
      endpoint: `/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}`,
      providerConfigKey,
      connectionId,
      retries: 3,
      params: { format: 'full' }
    });
    const events: ConnectedEmailThreadEvent[] = [];
    for (const message of thread.data.messages ?? []) {
      const messageId = String(message.id ?? '').trim();
      if (!messageId || messageId === input.externalRef) continue;
      const headers = message.payload?.headers;
      const fromRaw = headerValue(headers, 'From');
      const from = addressFromHeader(fromRaw);
      const subject = headerValue(headers, 'Subject');
      const occurredAt = Number.isFinite(Number(message.internalDate))
        ? new Date(Number(message.internalDate)).toISOString()
        : undefined;
      const body = gmailPayloadText(message.payload) || undefined;
      if (from === recipient) {
        events.push({
          kind: classifyVerifiedInboundEmail({
            subject,
            body,
            autoSubmitted: headerValue(headers, 'Auto-Submitted')
          }),
          providerEventId: `gmail:${messageId}`,
          occurredAt,
          subject: subject || undefined,
          sender: from || undefined,
          body
        });
      } else if (bounceLike(fromRaw, subject)) {
        events.push({
          kind: classifyDeliveryFailure({ subject, body }),
          providerEventId: `gmail:${messageId}`,
          occurredAt,
          subject: subject || undefined,
          sender: from || undefined,
          body
        });
      }
    }
    return events;
  }

  if (provider === 'microsoft' || provider === 'outlook') {
    const sent = await nango.get<{ conversationId?: string }>({
      endpoint: `/v1.0/me/messages/${encodeURIComponent(input.externalRef)}`,
      providerConfigKey,
      connectionId,
      retries: 3,
      params: { $select: 'conversationId' }
    });
    const conversationId = String(sent.data.conversationId ?? '').trim();
    if (!conversationId) return [];
    const escapedConversationId = conversationId.replaceAll("'", "''");
    const conversation = await nango.get<{
      value?: Array<{
        id?: string;
        receivedDateTime?: string;
        subject?: string;
        from?: { emailAddress?: { address?: string; name?: string } };
        body?: { contentType?: string; content?: string };
        internetMessageHeaders?: Array<{ name?: string; value?: string }>;
      }>;
    }>({
      endpoint: '/v1.0/me/messages',
      providerConfigKey,
      connectionId,
      retries: 3,
      params: {
        $filter: `conversationId eq '${escapedConversationId}'`,
        $select: 'id,receivedDateTime,subject,from,body,internetMessageHeaders',
        $top: '50'
      }
    });
    const events: ConnectedEmailThreadEvent[] = [];
    for (const message of conversation.data.value ?? []) {
      const messageId = String(message.id ?? '').trim();
      if (!messageId || messageId === input.externalRef) continue;
      const from = String(message.from?.emailAddress?.address ?? '')
        .trim()
        .toLowerCase();
      const fromLabel = `${message.from?.emailAddress?.name ?? ''} ${from}`;
      const subject = String(message.subject ?? '');
      const occurredAt = message.receivedDateTime
        ? new Date(message.receivedDateTime).toISOString()
        : undefined;
      const body = providerBodyText(message.body?.contentType, message.body?.content) || undefined;
      const autoSubmitted = message.internetMessageHeaders?.find(
        (header) => String(header.name ?? '').toLowerCase() === 'auto-submitted'
      )?.value;
      if (from === recipient) {
        events.push({
          kind: classifyVerifiedInboundEmail({ subject, body, autoSubmitted }),
          providerEventId: `microsoft:${messageId}`,
          occurredAt,
          subject: subject || undefined,
          sender: from || undefined,
          body
        });
      } else if (bounceLike(fromLabel, subject)) {
        events.push({
          kind: classifyDeliveryFailure({ subject, body }),
          providerEventId: `microsoft:${messageId}`,
          occurredAt,
          subject: subject || undefined,
          sender: from || undefined,
          body
        });
      }
    }
    return events;
  }

  return [];
}
export async function syncNangoRecords(
  db: Db,
  input: {
    workspaceId: string;
    localConnectionId: string;
    provider: string;
    providerConfigKey: string;
    externalConnectionId: string;
    model: string;
    modifiedAfter?: string;
  }
): Promise<NangoSyncResult> {
  const nango = getNango();
  // Who "we" are in this workspace, so a meeting between colleagues is never
  // read as a meeting with a prospect.
  const ownEmails = await workspaceUserEmails(db, input.workspaceId);
  let cursor: string | null = null;
  let ingested = 0;
  let skipped = 0;
  let ignored = 0;
  do {
    const result: { records: Array<Record<string, unknown>>; next_cursor: string | null } =
      await nango.listRecords<Record<string, unknown>>({
        providerConfigKey: input.providerConfigKey,
        connectionId: input.externalConnectionId,
        model: input.model,
        modifiedAfter: cursor ? undefined : input.modifiedAfter,
        cursor,
        limit: 100
      });
    for (const raw of result.records) {
      let outcome: SyncedRecord;
      let stored: IngestOutcome | null = null;
      try {
        outcome = await normalizeSyncedRecord(
          db,
          input.workspaceId,
          input.provider,
          input.model,
          raw as Record<string, unknown>,
          ownEmails
        );
        if (outcome.kind === 'record') {
          stored = await ingestCanonicalRecord(
            db,
            input.workspaceId,
            input.provider,
            input.localConnectionId,
            outcome.record
          );
        }
      } catch (error) {
        // Backstop: one record that fails validation is skipped, never the whole batch.
        // Anything else (database, network) still fails the sync.
        if (!(error instanceof ZodError)) throw error;
        outcome = { kind: 'skipped' };
      }
      if (outcome.kind === 'skipped') {
        // COUNTED, NOT SWALLOWED. A record no canonical kind can read -- a model
        // with no alias, or a calendar event in a shape this build does not
        // parse -- is reported on the connection. Dropping it silently made a
        // connection that stores nothing look identical to one with nothing new.
        skipped += 1;
        continue;
      }
      if (outcome.kind === 'ignored') {
        // Read and deliberately left out: internal, personal or all-day events,
        // and meetings with nobody already in the workspace.
        ignored += 1;
        continue;
      }
      if (stored?.stored) ingested += 1;
      else ignored += 1;
    }
    cursor = result.next_cursor;
  } while (cursor);
  return { ingested, skipped, ignored };
}

/**
 * What one sync actually did.
 *
 * Three numbers rather than one, because "nothing arrived", "what arrived was
 * deliberately left out" and "what arrived could not be read" are different
 * facts, and only the last is a problem the operator can act on.
 */
export interface NangoSyncResult {
  ingested: number;
  skipped: number;
  ignored: number;
}

/** Whether a canonical record was kept. A calendar meeting with nobody Trevra knows is not. */
export interface IngestOutcome {
  stored: boolean;
}

/** Facts about the ingress path, never read from the record itself. */
export interface IngestOptions {
  /** Only the Cal.com webhook passes 'booking'; every other path is a calendar observation. */
  meetingOrigin?: 'booking';
}

/**
 * A record from the designated inbound mailbox's Nango sync. Unlike the legacy
 * message path it never creates a Person: mail that is not from a known Person,
 * or did not arrive through the designated mailbox, is dropped before a single
 * row is written.
 */
async function ingestInboundMailboxMessage(
  db: Db,
  workspaceId: string,
  provider: string,
  connectionId: string | null,
  record: Extract<CanonicalRecord, { kind: 'message' }>
): Promise<IngestOutcome> {
  const now = new Date();
  const decision = await decideInboundMailboxRecord(db, workspaceId, connectionId, record, now);
  if (decision.action === 'ignore') return { stored: false };
  const sourceId = await upsertSourceRecord(
    db,
    workspaceId,
    connectionId,
    provider,
    record.kind,
    record.id,
    record.externalUrl ?? null,
    record,
    record.occurredAt
  );
  const accountId = await accountForPerson(db, workspaceId, decision.personId);
  const existing = await db
    .prepare('SELECT id FROM messages WHERE workspace_id=? AND source_record_id=?')
    .get<{ id: string }>(workspaceId, sourceId);
  const messageId = existing?.id ?? id('msg');
  if (existing) {
    await db
      .prepare(
        'UPDATE messages SET person_id=?,account_id=?,direction=?,subject=?,body=?,occurred_at=? WHERE id=? AND workspace_id=?'
      )
      .run(
        decision.personId,
        accountId,
        'inbound',
        record.subject,
        record.body,
        record.occurredAt,
        messageId,
        workspaceId
      );
  } else {
    await db
      .prepare(
        'INSERT INTO messages (id,workspace_id,person_id,account_id,direction,subject,body,occurred_at,source_record_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
      )
      .run(
        messageId,
        workspaceId,
        decision.personId,
        accountId,
        'inbound',
        record.subject,
        record.body,
        record.occurredAt,
        sourceId,
        now.toISOString()
      );
  }
  await projectCanonicalMessage(db, workspaceId, messageId, now, {
    sourceType: 'inbound_mailbox_message',
    outcomeKind: decision.outcomeKind
  });
  return { stored: true };
}

export async function ingestCanonicalRecord(
  db: Db,
  workspaceId: string,
  provider: string,
  connectionId: string | null,
  input: CanonicalRecord,
  options?: IngestOptions
): Promise<IngestOutcome> {
  const record = canonicalRecordSchema.parse(input);
  if (record.kind === 'message' && record.mailboxAddress) {
    return ingestInboundMailboxMessage(db, workspaceId, provider, connectionId, record);
  }
  const now = new Date().toISOString();
  if (record.kind === 'meeting') {
    return ingestMeeting(
      db,
      workspaceId,
      provider,
      connectionId,
      { ...record, origin: options?.meetingOrigin ?? 'calendar' },
      now
    );
  }
  const sourceId = await upsertSourceRecord(
    db,
    workspaceId,
    connectionId,
    provider,
    record.kind,
    record.id,
    record.externalUrl ?? null,
    record,
    'occurredAt' in record ? record.occurredAt : now
  );

  const identity = await resolveCanonicalRecordIdentity(
    db,
    workspaceId,
    provider,
    record.personName,
    record.personEmail,
    now
  );

  switch (record.kind) {
    case 'message': {
      const existing = await db
        .prepare('SELECT id FROM messages WHERE source_record_id=?')
        .get<{ id: string }>(sourceId);
      const messageId = existing?.id ?? id('msg');
      if (existing) {
        await db
          .prepare(
            'UPDATE messages SET person_id=?,account_id=?,direction=?,subject=?,body=?,occurred_at=? WHERE id=? AND workspace_id=?'
          )
          .run(
            identity.personId,
            identity.accountId,
            record.direction,
            record.subject,
            record.body,
            record.occurredAt,
            messageId,
            workspaceId
          );
      } else {
        await db
          .prepare(
            'INSERT INTO messages (id,workspace_id,person_id,account_id,direction,subject,body,occurred_at,source_record_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
          )
          .run(
            messageId,
            workspaceId,
            identity.personId,
            identity.accountId,
            record.direction,
            record.subject,
            record.body,
            record.occurredAt,
            sourceId,
            now
          );
      }
      await projectCanonicalMessage(db, workspaceId, messageId, new Date(now));
      break;
    }
    case 'opportunity': {
      const existing = await db
        .prepare('SELECT id FROM opportunities WHERE source_record_id=?')
        .get<{ id: string }>(sourceId);
      if (existing) {
        await db
          .prepare(
            'UPDATE opportunities SET person_id=?,account_id=?,title=?,stage=?,proposal_sent_at=?,expected_response_at=?,updated_at=? WHERE id=? AND workspace_id=?'
          )
          .run(
            identity.personId,
            identity.accountId,
            record.title,
            normalizeOpportunityStage(record.status),
            record.proposalSentAt ?? null,
            record.expectedResponseAt ?? null,
            now,
            existing.id,
            workspaceId
          );
      } else {
        await db
          .prepare(
            'INSERT INTO opportunities (id,workspace_id,person_id,account_id,title,stage,proposal_sent_at,expected_response_at,source_record_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
          )
          .run(
            id('opp'),
            workspaceId,
            identity.personId,
            identity.accountId,
            record.title,
            normalizeOpportunityStage(record.status),
            record.proposalSentAt ?? null,
            record.expectedResponseAt ?? null,
            sourceId,
            now,
            now
          );
      }
      break;
    }
  }
  return { stored: true };
}

/**
 * A meeting is a time and one matched Person.
 *
 * Identity differs by origin. A Cal.com booking resolves (and may create) the
 * Person, because somebody chose to book. A calendar event attaches only to a
 * Person who already exists, so a dentist appointment or a family dinner never
 * becomes a contact. Nothing is written for a meeting that will not be kept, so
 * an ignored event leaves no source record either. `record.origin` is the
 * ingress-assigned origin, never the payload's.
 */
async function ingestMeeting(
  db: Db,
  workspaceId: string,
  provider: string,
  connectionId: string | null,
  record: CanonicalMeeting,
  now: string
): Promise<IngestOutcome> {
  if (record.status !== 'cancelled') activeMeetingSchema.parse(record);
  // Decide "will this be kept" before anything is written, so a tombstone that
  // cannot be stored never creates a Person.
  if (
    record.status === 'cancelled' &&
    (!record.personEmail || !record.startAt || !record.endAt) &&
    !(await meetingKnown(db, { workspaceId, provider, externalId: record.id }))
  ) {
    return { stored: false };
  }
  // A signed booking cancellation may create the Person, like the booking itself:
  // its tombstone is what keeps a late create or reschedule from reviving it.
  const identity = !record.personEmail
    ? { personId: null, accountId: null }
    : record.origin === 'booking'
      ? await resolveCanonicalRecordIdentity(
          db,
          workspaceId,
          provider,
          record.personName,
          record.personEmail,
          now
        )
      : await findMeetingPerson(db, workspaceId, record.personEmail);
  if (record.status !== 'cancelled' && !identity.personId) return { stored: false };
  if (
    record.status === 'cancelled' &&
    !(await meetingKnown(db, { workspaceId, provider, externalId: record.id })) &&
    (!identity.personId || !record.startAt || !record.endAt)
  ) {
    return { stored: false };
  }
  const sourceId = await upsertSourceRecord(
    db,
    workspaceId,
    connectionId,
    provider,
    record.kind,
    record.id,
    record.externalUrl ?? null,
    record,
    record.startAt ?? now
  );
  const applied = await applyMeetingRecord(
    db,
    {
      workspaceId,
      provider,
      sourceRecordId: sourceId,
      personId: identity.personId,
      accountId: identity.accountId,
      record
    },
    new Date(now)
  );
  return { stored: applied.meetingId !== null };
}

export function getNango(): Nango {
  const apiKey = process.env.NANGO_API_KEY;
  if (!apiKey) throw new Error('NANGO_API_KEY is not configured');
  return new Nango({
    apiKey,
    webhookSigningKey: process.env.NANGO_WEBHOOK_SIGNING_KEY,
    host: process.env.NANGO_HOST
  });
}

function syncNamesForProvider(provider: string): string[] {
  const configured = process.env[`NANGO_SYNCS_${provider.toUpperCase().replaceAll('-', '_')}`];
  return configured
    ? configured
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

const MODEL_ALIASES: Record<string, CanonicalRecord['kind']> = {
  trevramessage: 'message',
  trevra_message: 'message',
  messages: 'message',
  trevraopportunity: 'opportunity',
  trevra_opportunity: 'opportunity',
  opportunities: 'opportunity',
  trevrameeting: 'meeting',
  trevrameetings: 'meeting',
  meeting: 'meeting',
  meetings: 'meeting',
  googlecalendarevent: 'meeting',
  calendarevent: 'meeting',
  events: 'meeting'
};

function canonicalKindForModel(model: string): CanonicalRecord['kind'] | null {
  const kind = model.toLowerCase().replaceAll('-', '_');
  return MODEL_ALIASES[kind.replaceAll('_', '')] ?? MODEL_ALIASES[kind] ?? null;
}

function normalizeNangoRecord(model: string, raw: Record<string, unknown>): CanonicalRecord | null {
  const deleted = nangoRecordDeleted(raw);
  const payload = { ...raw } as Record<string, unknown>;
  delete payload._nango_metadata;
  const resolved = payload.kind ? null : canonicalKindForModel(model);
  if (!payload.kind && !resolved) return null;
  const parsed = canonicalRecordSchema.safeParse(
    payload.kind ? payload : { ...payload, kind: resolved }
  );
  // Unparseable: counted as skipped by the caller, never allowed to abort the batch.
  if (!parsed.success) return null;
  const record = parsed.data;
  if (record.kind !== 'meeting') return record;
  // A meeting Nango reports as deleted is a cancelled meeting, never a live one.
  if (deleted) return { ...record, status: 'cancelled' };
  // A live meeting without a person and both times (a Microsoft Graph event on a
  // meeting alias model, say) is unreadable here, not a reason to abort the batch.
  if (record.status !== 'cancelled' && !activeMeetingSchema.safeParse(record).success) return null;
  return record;
}

type SyncedRecord =
  { kind: 'record'; record: CanonicalRecord } | { kind: 'skipped' } | { kind: 'ignored' };

/**
 * A synced record, read for this workspace.
 *
 * On the Google Calendar provider, meeting models whose records are not already
 * canonical are read as Calendar events. Real events carry `kind: "calendar#event"`,
 * so only a canonical kind literal opts a record out. Everything else takes the
 * canonical alias path.
 */
const CANONICAL_KINDS = new Set<unknown>(['message', 'opportunity', 'meeting']);

async function normalizeSyncedRecord(
  db: Db,
  workspaceId: string,
  provider: string,
  model: string,
  raw: Record<string, unknown>,
  ownEmails: ReadonlySet<string>
): Promise<SyncedRecord> {
  if (
    provider === 'google-calendar' &&
    !CANONICAL_KINDS.has(raw.kind) &&
    canonicalKindForModel(model) === 'meeting'
  ) {
    const meeting = await meetingFromCalendarEvent(db, workspaceId, raw, ownEmails);
    if (meeting.ok) return { kind: 'record', record: meeting.record };
    if (meeting.reason === 'unrecognized') return { kind: 'skipped' };
    // Left out now (all-day, internal, or the matched Person is no longer on it), but
    // stored earlier: it is no longer a meeting with a prospect, so cancel that row.
    const externalId = typeof raw.id === 'string' ? raw.id : '';
    if (externalId && (await meetingKnown(db, { workspaceId, provider, externalId }))) {
      return {
        kind: 'record',
        record: { kind: 'meeting', id: externalId, status: 'cancelled', origin: 'calendar' }
      };
    }
    return { kind: 'ignored' };
  }
  const normalized = normalizeNangoRecord(model, raw);
  // Inbound-mailbox records must never reach the legacy path, which creates Persons.
  if (
    model === INBOUND_EMAIL_MESSAGE_MODEL &&
    !(normalized?.kind === 'message' && normalized.mailboxAddress)
  ) {
    return { kind: 'skipped' };
  }
  return normalized ? { kind: 'record', record: normalized } : { kind: 'skipped' };
}

type OpportunityStage = 'new' | 'qualified' | 'meeting' | 'proposal' | 'won' | 'lost';

function normalizeOpportunityStage(value: string): OpportunityStage {
  const stage = value.trim().toLowerCase().replaceAll('-', '_');
  if (stage === 'qualified') return 'qualified';
  if (stage === 'meeting' || stage === 'meeting_booked') return 'meeting';
  if (stage === 'proposal' || stage === 'proposal_sent') return 'proposal';
  if (stage === 'won' || stage === 'closed_won') return 'won';
  if (stage === 'lost' || stage === 'closed_lost') return 'lost';
  return 'new';
}

async function resolveCanonicalRecordIdentity(
  db: Db,
  workspaceId: string,
  provider: string,
  contactName: string | undefined,
  email: string | undefined,
  now: string
): Promise<{ personId: string | null; accountId: string | null }> {
  const normalizedEmail = email?.trim().toLowerCase() || null;
  if (!normalizedEmail) return { personId: null, accountId: null };

  const canonicalPerson = await resolveContact(
    db,
    workspaceId,
    { name: contactName?.trim() || null, email: normalizedEmail },
    new Date(now)
  );
  const personId = canonicalPerson.contact.id;
  await upsertPersonIdentity(
    db,
    {
      workspaceId,
      personId,
      provider,
      identityType: 'email',
      identityValue: normalizedEmail
    },
    new Date(now)
  );
  return {
    personId,
    accountId: await accountForPerson(db, workspaceId, personId)
  };
}

async function upsertSourceRecord(
  db: Db,
  workspaceId: string,
  connectionId: string | null,
  provider: string,
  objectType: string,
  externalId: string,
  externalUrl: string | null,
  payload: unknown,
  occurredAt: string
): Promise<string> {
  const payloadJson = JSON.stringify(payload);
  const contentHash = sha(payloadJson);
  const existing = (await db
    .prepare(
      'SELECT id FROM source_records WHERE workspace_id=? AND provider=? AND object_type=? AND external_id=?'
    )
    .get(workspaceId, provider, objectType, externalId)) as { id: string } | undefined;
  const sourceId = existing?.id ?? id('src');
  const now = new Date().toISOString();
  await db
    .prepare(
      `
    INSERT INTO source_records (id,workspace_id,connection_id,provider,object_type,external_id,external_url,content_hash,occurred_at,payload_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(workspace_id,provider,object_type,external_id) DO UPDATE SET
      connection_id=excluded.connection_id,external_url=excluded.external_url,content_hash=excluded.content_hash,
      occurred_at=excluded.occurred_at,payload_json=excluded.payload_json,updated_at=excluded.updated_at
  `
    )
    .run(
      sourceId,
      workspaceId,
      connectionId,
      provider,
      objectType,
      externalId,
      externalUrl,
      contentHash,
      occurredAt,
      payloadJson,
      now,
      now
    );
  return sourceId;
}

/**
 * Claim an event id, per tenant rather than per deployment.
 *
 * The conflict target names migration 058's index verbatim --
 * `idx_webhook_events_tenant_idempotency` on
 * (COALESCE(workspace_id,'@unresolved'), provider, external_event_id) -- which
 * replaced the global UNIQUE(provider, external_event_id) from 001. Providers
 * allocate event ids per account, not globally, so under the old rule two
 * tenants handed the same id meant the second one's event was silently
 * swallowed as a duplicate: one tenant denying another their idempotency, and
 * an existence oracle into the bargain.
 *
 * Every call here inserts with a NULL workspace, because a webhook arrives
 * before anyone knows whose it is, so unresolved redeliveries still dedupe
 * against each other in the sentinel bucket. `completeWebhook` moves the row
 * into its own tenant's bucket once resolution succeeds, which is what frees
 * the id for the next tenant.
 */
async function recordWebhook(
  db: Db,
  provider: string,
  externalEventId: string,
  workspaceId: string | null,
  payloadHash: string
): Promise<boolean> {
  const result = await db
    .prepare(
      "INSERT INTO webhook_events (id,provider,external_event_id,workspace_id,payload_hash,status,received_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT (COALESCE(workspace_id,'@unresolved'),provider,external_event_id) DO NOTHING"
    )
    .run(
      id('webhook'),
      provider,
      externalEventId,
      workspaceId,
      payloadHash,
      'received',
      new Date().toISOString()
    );
  return result.changes > 0;
}

/**
 * Close out the row this request opened -- and only that row.
 *
 * `workspace_id IS NOT DISTINCT FROM ?` addresses the exact row this request
 * claimed -- the tenant's own row when the event was attributed, the sentinel
 * row when it was not. Without it, an UPDATE keyed on (provider,
 * external_event_id) alone would now match every workspace that has ever been
 * handed that same provider event id and overwrite all of their statuses.
 *
 * It no longer MOVES a row between buckets. It used to
 * (`workspace_id=COALESCE(?,workspace_id)`), and that was the dedupe bug: an
 * event recorded unattributed and then resolved vacated the `@unresolved` slot,
 * so the provider's next redelivery of the same event found the slot empty and
 * was processed all over again. Callers resolve
 * the tenant before claiming the id, so the row is born in its final bucket.
 */
async function completeWebhook(
  db: Db,
  provider: string,
  externalEventId: string,
  status: string,
  error: string | null,
  workspaceId: string | null
): Promise<void> {
  await db
    .prepare(
      'UPDATE webhook_events SET status=?,error=?,processed_at=? WHERE provider=? AND external_event_id=? AND workspace_id IS NOT DISTINCT FROM ?'
    )
    .run(status, error, new Date().toISOString(), provider, externalEventId, workspaceId);
}

/**
 * One RFC 5322 message as raw MIME text: Gmail wants it base64url, Graph's MIME
 * send wants standard base64. Header values are checked for CR/LF/NUL so a
 * recipient or extra header can never smuggle in another header; the 400 makes
 * that a definite failure (no provider call happened).
 */
export function buildMimeMessage(input: {
  recipient: string;
  subject: string;
  body: string;
  idempotencyKey: string;
  inReplyTo?: string | null;
  htmlBody?: string | null;
  extraHeaders?: string[];
}): string {
  const extraHeaders = input.extraHeaders ?? [];
  if (
    [input.recipient, input.idempotencyKey, input.inReplyTo ?? '', ...extraHeaders].some((value) =>
      /[\r\n\0]/.test(value)
    )
  ) {
    throw Object.assign(
      new Error('Email header values cannot contain line breaks or NUL characters.'),
      { status: 400 }
    );
  }
  if (extraHeaders.some((header) => !/^[!-9;-~]+: /.test(header))) {
    throw Object.assign(new Error('Extra email headers must be "Name: value" lines.'), {
      status: 400
    });
  }
  const encodedSubject = `=?UTF-8?B?${Buffer.from(input.subject).toString('base64')}?=`;
  const headers = [
    `To: ${input.recipient}`,
    `Subject: ${encodedSubject}`,
    ...(input.inReplyTo
      ? [`In-Reply-To: ${input.inReplyTo}`, `References: ${input.inReplyTo}`]
      : []),
    `Message-ID: <${input.idempotencyKey}@trevra.app>`,
    `X-Trevra-Idempotency-Key: ${input.idempotencyKey}`,
    ...extraHeaders,
    'MIME-Version: 1.0'
  ];
  if (input.htmlBody) {
    const boundary = `trevra-${sha(input.idempotencyKey).slice(0, 24)}`;
    return [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      input.body,
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      input.htmlBody,
      `--${boundary}--`,
      ''
    ].join('\r\n');
  }
  return [
    ...headers,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    input.body
  ].join('\r\n');
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
