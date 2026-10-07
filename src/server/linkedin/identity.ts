import type { Db } from '../db.js';
import { normalisedProfileUrl } from './driver.js';

/**
 * WHICH LINKEDIN MEMBER A SEAT IS.
 *
 * LinkedIn limits a PERSON, not a Trevra workspace. A founder who connects the
 * same profile to two workspaces must get one budget, not two. The key is the
 * canonical profile URL the companion read off its OWN signed-in page during
 * detection -- never a URL an operator typed, which would let anyone attach
 * their seat to somebody else's budget.
 *
 * Lowercased and without the trailing slash, so every rendering of one handle
 * is one key. Null for anything that is not a `/in/<handle>` member profile.
 */
export function seatIdentityKey(profileUrl: string | null | undefined): string | null {
  if (!profileUrl) return null;
  const normalised = normalisedProfileUrl(profileUrl);
  if (!normalised) return null;
  const key = normalised.toLowerCase().replace(/\/+$/, '');
  return key.length > 0 && key.length <= 300 ? key : null;
}

/**
 * Record (or forget) the member this seat signed in as.
 *
 * Called only from `detectLinkedInSeat` after a successful `readSeat`, so the
 * fact written here was observed, not asserted. An unreadable profile removes
 * the link: a seat Trevra cannot identify falls back to its own per-seat
 * budget rather than keeping a stale claim to somebody else's.
 *
 * OBSERVED IS NOT PROVEN. In hosted companion mode the page is read through a
 * browser the tenant controls, so a forged `/in/me/` could name anybody's
 * profile. The key therefore links nothing on its own: `boundUserId` is the
 * authenticated Trevra user who asked for this detect (server-resolved, never
 * client input), and two seats share a budget only when the SAME user is bound
 * to both and is a current member of both workspaces -- checked at read time
 * in `seatLedgerFacts` (guard.ts) and `linked_seat_count` (seats.ts). Null
 * means no user is known; the identity is recorded and links nothing.
 */
export async function recordSeatIdentity(
  db: Db,
  workspaceId: string,
  seatKey: string,
  profileUrl: string | null | undefined,
  now: Date,
  boundUserId: string | null = null
): Promise<string | null> {
  const key = seatIdentityKey(profileUrl);
  if (!key) {
    await db
      .prepare('DELETE FROM linkedin_seat_identities WHERE workspace_id=? AND seat_key=?')
      .run(workspaceId, seatKey);
    return null;
  }
  await db
    .prepare(
      `INSERT INTO linkedin_seat_identities (workspace_id, seat_key, identity_key, confirmed_at, bound_user_id)
       VALUES (?,?,?,?::timestamptz,?)
       ON CONFLICT (workspace_id, seat_key) DO UPDATE SET
         identity_key = excluded.identity_key,
         confirmed_at = excluded.confirmed_at,
         bound_user_id = excluded.bound_user_id`
    )
    .run(workspaceId, seatKey, key, now.toISOString(), boundUserId);
  return key;
}
