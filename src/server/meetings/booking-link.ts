import type { Db } from '../db.js';

export const BOOKING_URL_MAX_LENGTH = 500;

export class BookingUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BookingUrlError';
  }
}

const NOT_HTTPS =
  'The booking link must be a full https:// address, for example https://cal.com/you/intro.';

/** The operator's exact link, trimmed; blank means "no link". */
export function normalizeBookingUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return null;
  if (trimmed.length > BOOKING_URL_MAX_LENGTH) {
    throw new BookingUrlError(
      `The booking link must be ${BOOKING_URL_MAX_LENGTH} characters or fewer.`
    );
  }
  // The URL parser percent-encodes most control characters instead of refusing them.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new BookingUrlError('The booking link must not contain control characters.');
  }
  if (/\s/.test(trimmed)) throw new BookingUrlError(NOT_HTTPS);
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new BookingUrlError(NOT_HTTPS);
  }
  if (url.protocol !== 'https:' || !url.hostname) throw new BookingUrlError(NOT_HTTPS);
  if (url.username || url.password) {
    throw new BookingUrlError('The booking link must not contain a username or password.');
  }
  return trimmed;
}

export async function getBookingUrl(db: Db, workspaceId: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT booking_url FROM workspace_settings WHERE workspace_id=?')
    .get<{ booking_url: string | null }>(workspaceId);
  return row?.booking_url ?? null;
}

/** Upsert: an older workspace may have no settings row; every other column has a default. */
export async function setBookingUrl(
  db: Db,
  workspaceId: string,
  value: string | null,
  now: Date = new Date()
): Promise<string | null> {
  const bookingUrl = normalizeBookingUrl(value);
  const at = now.toISOString();
  await db
    .prepare(
      `INSERT INTO workspace_settings (workspace_id,booking_url,created_at,updated_at) VALUES (?,?,?,?)
       ON CONFLICT (workspace_id) DO UPDATE SET booking_url=excluded.booking_url,updated_at=excluded.updated_at`
    )
    .run(workspaceId, bookingUrl, at, at);
  return bookingUrl;
}
