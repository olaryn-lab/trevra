import { z } from 'zod/v3';
import type { Db } from '../db.js';
import { normalizeSenderDomain } from './deliverability.js';

/** One or more lowercase DNS labels: the part of a DKIM record name before ._domainkey. */
export const DKIM_SELECTOR_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export const dkimSelectorSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Enter the DKIM selector, or clear it.')
  .max(200, 'A DKIM selector is at most 200 characters.')
  .regex(
    DKIM_SELECTOR_PATTERN,
    'Enter the DKIM selector exactly as your mail provider shows it, for example zmail: the part before ._domainkey.'
  );

/** The owner-set selector for one sending domain in this workspace, or null. */
export async function readDkimSelector(
  db: Db,
  workspaceId: string,
  domain: string
): Promise<string | null> {
  const row = await db
    .prepare('SELECT selector FROM email_dkim_selectors WHERE workspace_id=? AND domain=?')
    .get<{ selector: string }>(workspaceId, normalizeSenderDomain(domain));
  return row?.selector ?? null;
}

/** Set (or, with null or blank, clear) the owner's selector. Returns what is stored. */
export async function writeDkimSelector(
  db: Db,
  input: {
    workspaceId: string;
    domain: string;
    selector: string | null;
    actorUserId: string | null;
  },
  now: Date = new Date()
): Promise<string | null> {
  const domain = normalizeSenderDomain(input.domain);
  if (input.selector === null || input.selector.trim() === '') {
    await db
      .prepare('DELETE FROM email_dkim_selectors WHERE workspace_id=? AND domain=?')
      .run(input.workspaceId, domain);
    return null;
  }
  const selector = dkimSelectorSchema.parse(input.selector);
  await db
    .prepare(
      `INSERT INTO email_dkim_selectors (workspace_id,domain,selector,updated_by_user_id,updated_at)
       VALUES (?,?,?,?,?::timestamptz)
       ON CONFLICT (workspace_id,domain) DO UPDATE SET
         selector=excluded.selector,updated_by_user_id=excluded.updated_by_user_id,
         updated_at=excluded.updated_at`
    )
    .run(input.workspaceId, domain, selector, input.actorUserId, now.toISOString());
  return selector;
}
