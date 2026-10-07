import type { Db } from '../db.js';
import { secretsConfigured } from '../secrets/crypto.js';
import { getBookingUrl } from './booking-link.js';

const UTC_ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

export interface MeetingsSetup {
  bookingUrl: string | null;
  secretsConfigured: boolean;
  googleCalendar: {
    connected: boolean;
    status: string | null;
    lastSyncedAt: string | null;
    lastError: string | null;
  };
  /**
   * Content-free on purpose: endpoint ids, paths and counts stay behind the
   * owner-only `/api/setup/webhooks` routes.
   */
  calcomConnected: boolean;
}

/** Everything every workspace member may see about meetings setup; never a secret or endpoint. */
export async function readMeetingsSetup(db: Db, workspaceId: string): Promise<MeetingsSetup> {
  const [bookingUrl, calcom, connection] = await Promise.all([
    getBookingUrl(db, workspaceId),
    db
      .prepare(
        `SELECT EXISTS (
           SELECT 1 FROM provider_webhook_endpoints
           WHERE workspace_id=? AND provider='calcom' AND status='active'
         ) AS connected`
      )
      .get<{ connected: boolean }>(workspaceId),
    db
      .prepare(
        `SELECT status,TO_CHAR(last_synced_at AT TIME ZONE 'UTC', ${UTC_ISO}) AS last_synced_at,last_error
         FROM connections WHERE workspace_id=? AND provider='google-calendar'
         ORDER BY updated_at DESC,id ASC LIMIT 1`
      )
      .get<{ status: string; last_synced_at: string | null; last_error: string | null }>(
        workspaceId
      )
  ]);
  return {
    bookingUrl,
    secretsConfigured: secretsConfigured(),
    googleCalendar: {
      connected: connection?.status === 'connected',
      status: connection?.status ?? null,
      lastSyncedAt: connection?.last_synced_at ?? null,
      lastError: connection?.last_error ?? null
    },
    calcomConnected: calcom?.connected === true
  };
}
