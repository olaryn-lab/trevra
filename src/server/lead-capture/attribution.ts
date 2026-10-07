import type { Db } from '../db.js';
import { MILESTONE_KINDS_SQL } from './milestones.js';

export const ATTRIBUTION_WINDOW_DAYS = 90;

export interface AttributionCount {
  value: string;
  submissions: number;
  people: number;
  peopleWithOpportunity: number;
}

export interface InboundAttributionSummary {
  since: string;
  days: number;
  byUtmSource: AttributionCount[];
  byHeardAbout: AttributionCount[];
}

const ATTRIBUTION_FIELDS = ['utm_source', 'heard_about'] as const;
type AttributionField = (typeof ATTRIBUTION_FIELDS)[number];

async function countBy(
  db: Db,
  workspaceId: string,
  since: string,
  field: AttributionField
): Promise<AttributionCount[]> {
  // `field` comes from the closed tuple above, never from input.
  const rows = await db
    .prepare(
      `WITH recent AS (
         SELECT s.contact_id,
                NULLIF(LOWER(BTRIM(s.attribution_json->>'${field}')),'') AS value
         FROM inbound_submissions s
         WHERE s.workspace_id=? AND s.received_at>=?::timestamptz
           AND s.kind NOT IN ${MILESTONE_KINDS_SQL}
       ),
       opportunity_people AS (
         SELECT DISTINCT person_id FROM opportunities
         WHERE workspace_id=? AND person_id IS NOT NULL
       )
       SELECT r.value,
              COUNT(*)::int AS submissions,
              COUNT(DISTINCT r.contact_id)::int AS people,
              COUNT(DISTINCT op.person_id)::int AS people_with_opportunity
       FROM recent r
       LEFT JOIN opportunity_people op ON op.person_id=r.contact_id
       WHERE r.value IS NOT NULL
       GROUP BY r.value
       ORDER BY people DESC, r.value ASC
       LIMIT 12`
    )
    .all<{
      value: string;
      submissions: number;
      people: number;
      people_with_opportunity: number;
    }>(workspaceId, since, workspaceId);
  return rows.map((row) => ({
    value: String(row.value),
    submissions: Number(row.submissions),
    people: Number(row.people),
    peopleWithOpportunity: Number(row.people_with_opportunity)
  }));
}

/**
 * A deliberately small read model: where inbound people came from over the
 * last 90 days. Counts only; no person, message or page content.
 */
export async function inboundAttributionSummary(
  db: Db,
  workspaceId: string,
  now: Date = new Date()
): Promise<InboundAttributionSummary> {
  const since = new Date(now.getTime() - ATTRIBUTION_WINDOW_DAYS * 86_400_000).toISOString();
  const [byUtmSource, byHeardAbout] = await Promise.all([
    countBy(db, workspaceId, since, 'utm_source'),
    countBy(db, workspaceId, since, 'heard_about')
  ]);
  return { since, days: ATTRIBUTION_WINDOW_DAYS, byUtmSource, byHeardAbout };
}
