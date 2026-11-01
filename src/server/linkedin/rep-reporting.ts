import type { Db } from '../db.js';
import { safeCsvCell } from '../csv.js';
import { COUNTED_MESSAGE_KINDS } from './actions.js';
import { EMAIL_REPLY_EVENT_KIND, type CampaignEmailEventKind } from './email-event-kind.js';
import { localDateOf, zonedToUtc, type LocalDate } from './pacing.js';

/**
 * Per-rep outreach reporting and the stats exports (TRV-046, TRV-049).
 *
 * ONE FACT TABLE, MANY CUTS. Every number this module reports -- the team
 * table, the per-campaign table, the daily series and all three CSV exports --
 * is an aggregate over the same set of facts, built by one SQL statement
 * ({@link aggregate}). A CSV can therefore never disagree with the screen it
 * was downloaded from: it is the same query with a different GROUP BY.
 *
 * WHO A NUMBER BELONGS TO -- the attribution rule, in precedence order. The
 * first rule that yields a person wins:
 *
 *   1. `linkedin_actions.queued_by_user_id` -- the member whose own live
 *      request queued the action (a manual queue, an inbox reply, an
 *      engagement). Frozen on the row when it was written.
 *   2. `linkedin_seats.owner_user_id` -- the member assigned to the LinkedIn
 *      account that performed it. Email has no LinkedIn account and skips this.
 *   3. `linkedin_campaigns.owner_user_id` -- the member who owns the campaign
 *      that planned it.
 *   4. The approver of the exact payload (`linkedin_action_approvals` /
 *      `linkedin_campaign_email_approvals`.`approved_by`). Approval needs
 *      `outreach.approve` (an owner or manager, src/server/roles.ts), so the
 *      approver is a reviewer, not the rep; it ranks below the seat and
 *      campaign for that reason, and above rule 5 so a multi-owner workspace
 *      credits the owner or manager who actually released the work.
 *   5. The workspace owner -- the earliest Better Auth owner of the
 *      organization, else the workspace's first legacy `users` row.
 *
 * DEPARTED MEMBERS KEEP THEIR HISTORY. Removing someone from the workspace
 * deletes their Better Auth `member` row and nothing else: the user ids on the
 * ledger, the seat and the campaign stay, so their numbers stay theirs and are
 * reported with status 'former'. Two honest limits, both from the schema:
 *
 *   - Rules 2 and 3 read the CURRENT seat and campaign owner, so reassigning a
 *     seat moves its unqueued history to the new owner. Rule 1 is frozen.
 *   - Deleting a user account outright nulls the FK columns (ON DELETE SET
 *     NULL), and that history falls through to the next rule.
 *
 * lc-debt: attribution for rules 2-4 is resolved at read time. Upgrade path: an
 * `attributed_user_id` column on `linkedin_actions` and
 * `linkedin_campaign_channel_actions`, written by the same rule at insert, so
 * reassigning a seat cannot move history.
 *
 * WHEN A NUMBER HAPPENED. LinkedIn work is dated by `linkedin_actions.recorded_at`
 * (the column every rolling ceiling and `managedAnalytics` count on), email by
 * the send's `completed_at`. An acceptance, a reply or a bounce is counted on
 * the row of the invite, message or email it answers, so it lands in the same
 * day bucket as that send -- which is what keeps every rate inside one
 * population. Days are cut at midnight in the workspace's own time zone
 * (`workspace_settings.timezone`, UTC when unset or invalid); a range is
 * `from` inclusive to `to` exclusive, both local dates.
 */

/** The widest range any report or export may cover, in days. */
export const MAX_REPORT_DAYS = 366;
/**
 * The most rows a team export may produce: selected members x days.
 *
 * A 400 past it, never a truncated file. 10,000 is a year for 27 people, or a
 * quarter for 108.
 */
export const MAX_TEAM_EXPORT_ROWS = 10_000;

export const REPORT_PRESETS = ['today', 'yesterday', '7d', '30d', '90d'] as const;
export type ReportPreset = (typeof REPORT_PRESETS)[number];

/** An expected refusal with the HTTP status it should travel as. */
export class RepReportError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
  }
}

export interface RepMetrics {
  /** Invites that went out: sent, accepted, replied or declined. Withdrawn and exported are not. */
  invitesSent: number;
  /** Of `invitesSent`, the ones accepted (a reply implies an acceptance). */
  invitesAccepted: number;
  /** `invitesAccepted / invitesSent`, or null at 0-of-0. */
  acceptanceRate: number | null;
  /** LinkedIn messages: DMs, replies, group and event messages. InMail has its own column. */
  messagesSent: number;
  inmailsSent: number;
  /** Campaign emails confirmed sent (`linkedin_campaign_channel_actions.status='sent'`). */
  emailsSent: number;
  /** Of `emailsSent`, the ones with a provider-confirmed hard bounce. */
  emailsBounced: number;
  /**
   * Distinct leads messaged on LinkedIn (InMail included) or emailed. A lead is
   * keyed by its lead contact when a campaign reached it, so one person reached
   * on both channels counts once.
   */
  messagedLeads: number;
  /** Distinct leads who replied to anything: an invite note, a message or an email. */
  replies: number;
  /** Distinct leads who replied to a message or an email -- a subset of `messagedLeads`. */
  repliedAfterMessage: number;
  /** `repliedAfterMessage / messagedLeads`, or null when nobody was messaged. Never above 1. */
  replyRate: number | null;
  follows: number;
  likes: number;
  endorsements: number;
  profileViews: number;
}

export interface ReportRange {
  /** First local date counted (inclusive), 'YYYY-MM-DD'. */
  from: string;
  /** First local date NOT counted (exclusive), 'YYYY-MM-DD'. */
  to: string;
  days: number;
  timezone: string;
  /** The instants the range spans: `from` 00:00 inclusive to `to` 00:00 exclusive, in `timezone`. */
  startsAt: string;
  endsAt: string;
  preset: ReportPreset | null;
}

export interface ReportDay extends RepMetrics {
  date: string;
  startsAt: string;
  endsAt: string;
}

export interface ReportCampaignRow extends RepMetrics {
  /** Null for work no campaign planned (manual queue, inbox replies). */
  campaignId: string | null;
  name: string | null;
  status: string | null;
}

export type MemberStatus = 'current' | 'former' | 'unattributed';

export interface ReportMemberRow extends RepMetrics {
  /** Null only for the 'unattributed' row: no rule above could name a person. */
  userId: string | null;
  name: string;
  status: MemberStatus;
}

export interface RepReport {
  range: ReportRange;
  filters: {
    seatKey: string | null;
    campaignId: string | null;
    /** False when a LinkedIn account is selected: no LinkedIn account sends email. */
    emailIncluded: boolean;
  };
  total: RepMetrics;
  days: ReportDay[];
  campaigns: ReportCampaignRow[];
  members: ReportMemberRow[];
  limits: { maxDays: number; maxTeamExportRows: number };
}

export interface ReportQuery {
  preset?: ReportPreset;
  from?: string;
  to?: string;
  seatKey?: string;
  campaignId?: string;
}

export interface CsvExport {
  filename: string;
  csv: string;
  rows: number;
}

/* ---------------------------------------------------------------------------
 * The range.
 * ------------------------------------------------------------------------ */

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseLocalDate(value: string, field: 'from' | 'to'): LocalDate {
  const match = DATE_PATTERN.exec(value);
  const date = match
    ? { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
    : null;
  const at = date ? new Date(Date.UTC(date.year, date.month - 1, date.day)) : null;
  if (
    !date ||
    !at ||
    at.getUTCFullYear() !== date.year ||
    at.getUTCMonth() !== date.month - 1 ||
    at.getUTCDate() !== date.day
  )
    throw new RepReportError(`'${field}' must be a calendar date written YYYY-MM-DD.`);
  return date;
}

function shiftDate(date: LocalDate, days: number): LocalDate {
  const at = new Date(Date.UTC(date.year, date.month - 1, date.day) + days * 86_400_000);
  return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() };
}

function dateKey(date: LocalDate): string {
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

function daysBetween(from: LocalDate, to: LocalDate): number {
  return Math.round(
    (Date.UTC(to.year, to.month - 1, to.day) - Date.UTC(from.year, from.month - 1, from.day)) /
      86_400_000
  );
}

/**
 * The zone this workspace's days are cut in.
 *
 * The workspace's own setting, because a team report spans seats in different
 * zones and the seat-majority zone `linkedinAnalytics` borrows would change
 * under the team the moment one seat moved. Validated before it reaches
 * `AT TIME ZONE`, which raises on an unknown name.
 */
export async function reportTimezone(db: Db, workspaceId: string): Promise<string> {
  const row = await db
    .prepare('SELECT timezone FROM workspace_settings WHERE workspace_id=?')
    .get<{ timezone: string | null }>(workspaceId);
  const zone = row?.timezone?.trim();
  if (!zone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return 'UTC';
  }
}

/**
 * A preset or an explicit `from`/`to`, resolved to local dates and instants.
 *
 * Presets end at the end of today, local: '7d' is today and the six days
 * before it. An explicit range is taken as written -- `to` exclusive -- and
 * refused rather than clamped when it is empty, backwards, or wider than
 * {@link MAX_REPORT_DAYS}.
 */
export function resolveReportRange(
  query: Pick<ReportQuery, 'preset' | 'from' | 'to'>,
  timezone: string,
  now: Date
): ReportRange {
  let from: LocalDate;
  let to: LocalDate;
  let preset: ReportPreset | null = null;
  if (query.from !== undefined || query.to !== undefined) {
    if (query.preset) throw new RepReportError('Send either a range preset or from/to, not both.');
    if (query.from === undefined || query.to === undefined)
      throw new RepReportError("A custom range needs both 'from' and 'to'.");
    from = parseLocalDate(query.from, 'from');
    to = parseLocalDate(query.to, 'to');
  } else {
    preset = query.preset ?? '30d';
    const today = localDateOf(now, timezone);
    const tomorrow = shiftDate(today, 1);
    if (preset === 'today') [from, to] = [today, tomorrow];
    else if (preset === 'yesterday') [from, to] = [shiftDate(today, -1), today];
    else {
      const span = Number(preset.replace('d', ''));
      [from, to] = [shiftDate(today, -(span - 1)), tomorrow];
    }
  }
  const days = daysBetween(from, to);
  if (days < 1)
    throw new RepReportError(
      "'to' must be after 'from'. The range is from inclusive, to exclusive."
    );
  if (days > MAX_REPORT_DAYS)
    throw new RepReportError(
      `A report covers at most ${MAX_REPORT_DAYS} days; this range is ${days}. Narrow it.`
    );
  return {
    from: dateKey(from),
    to: dateKey(to),
    days,
    timezone,
    startsAt: zonedToUtc(from, 0, timezone).toISOString(),
    endsAt: zonedToUtc(to, 0, timezone).toISOString(),
    preset
  };
}

/** Every local date in the range, with the instants it spans. Walked as dates, not milliseconds, so DST cannot skip or repeat one. */
function rangeDays(range: ReportRange): Array<{ date: string; startsAt: string; endsAt: string }> {
  const first = parseLocalDate(range.from, 'from');
  const out: Array<{ date: string; startsAt: string; endsAt: string }> = [];
  for (let offset = 0; offset < range.days; offset += 1) {
    const local = shiftDate(first, offset);
    out.push({
      date: dateKey(local),
      startsAt: zonedToUtc(local, 0, range.timezone).toISOString(),
      endsAt: zonedToUtc(shiftDate(local, 1), 0, range.timezone).toISOString()
    });
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Members.
 * ------------------------------------------------------------------------ */

interface WorkspaceMembers {
  /** Current members, Trevra `users.id` -> display name. */
  current: Map<string, string>;
  /** Rule 5's person, or null when the workspace has nobody to name. */
  ownerUserId: string | null;
}

/**
 * Who is in the workspace now, keyed by the Trevra `users.id` the ledger's FK
 * columns hold, and who its owner is.
 *
 * Better Auth owns membership: `member` rows join to its `user` by id and to
 * Trevra's `users` by email (the same mapping `resolveWorkspaceMemberUserId`
 * uses). A database without those tables yet, or a pre-organization workspace
 * with no member rows, falls back to the legacy `users.workspace_id` owner --
 * the same fallback `notifications.ts` takes for the same reason.
 */
async function workspaceMembers(db: Db, workspaceId: string): Promise<WorkspaceMembers> {
  let rows: Array<{ user_id: string; name: string; role: string }> = [];
  try {
    rows = await db
      .prepare(
        `SELECT u.id AS user_id, COALESCE(NULLIF(u.name,''), u.email) AS name, m.role AS role
         FROM member m
         JOIN "user" au ON au.id=m."userId"
         JOIN users u ON lower(u.email)=lower(au.email)
         WHERE m."organizationId"=?
         ORDER BY m."createdAt" ASC, u.id ASC`
      )
      .all<{ user_id: string; name: string; role: string }>(workspaceId);
  } catch (error) {
    if ((error as { code?: string })?.code !== '42P01') throw error;
  }
  if (rows.length > 0) {
    const owner = rows.find((row) =>
      String(row.role ?? '')
        .split(',')
        .map((part) => part.trim())
        .includes('owner')
    );
    return {
      current: new Map(rows.map((row) => [row.user_id, row.name])),
      ownerUserId: owner?.user_id ?? null
    };
  }
  const legacy = await db
    .prepare(
      `SELECT id AS user_id, COALESCE(NULLIF(name,''), email) AS name FROM users
       WHERE workspace_id=? ORDER BY created_at ASC, id ASC`
    )
    .all<{ user_id: string; name: string }>(workspaceId);
  return {
    current: new Map(legacy.map((row) => [row.user_id, row.name])),
    ownerUserId: legacy[0]?.user_id ?? null
  };
}

/** Display names for attributed ids that are no longer members. A row that is gone entirely says so. */
async function namesFor(db: Db, userIds: readonly string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .prepare(
      `SELECT id, COALESCE(NULLIF(name,''), email) AS name FROM users WHERE id = ANY(?::text[])`
    )
    .all<{ id: string; name: string }>([...userIds]);
  return new Map(rows.map((row) => [row.id, row.name]));
}

/* ---------------------------------------------------------------------------
 * The facts and their aggregate.
 * ------------------------------------------------------------------------ */

type GroupKey = 'day' | 'user_id' | 'campaign_id';
const GROUP_KEYS: readonly GroupKey[] = ['day', 'user_id', 'campaign_id'];

const EMAIL_BOUNCE_EVENT_KIND: CampaignEmailEventKind = 'bounce';

/**
 * Fixed identifiers inlined as SQL literals. Never operator input -- and not
 * bound, because `normalizeSql` numbers placeholders positionally and these
 * sit in the SELECT, before the WHERE's parameters.
 */
function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(', ');
}

interface Scope {
  workspaceId: string;
  range: ReportRange;
  ownerUserId: string | null;
  seatKey?: string;
  campaignId?: string;
}

interface AggregateRow {
  g_day: number;
  g_user_id: number;
  g_campaign_id: number;
  day: string | null;
  user_id: string | null;
  campaign_id: string | null;
  invites_sent: number;
  invites_accepted: number;
  messages_sent: number;
  inmails_sent: number;
  emails_sent: number;
  emails_bounced: number;
  messaged_leads: number;
  replies: number;
  replied_after_message: number;
  follows: number;
  likes: number;
  endorsements: number;
  profile_views: number;
}

/**
 * The fact table, aggregated over the requested GROUPING SETS in one scan.
 *
 * Distinct-lead counts (`messaged_leads`, `replies`, `replied_after_message`)
 * are distinct WITHIN each group, which is why they are computed here per set
 * rather than summed in JavaScript: a lead messaged on Monday and Wednesday is
 * one lead in the week's total and one lead on each of those days. Daily rows
 * of those three columns therefore need not add up to the range total.
 *
 * lc-debt: the workspace-wide range is a filter over the `(workspace_id, ...)`
 * prefix of the existing ledger indexes, not a range seek on `recorded_at`.
 * Seat- and campaign-filtered reads do seek (`idx_linkedin_actions_window`,
 * `idx_linkedin_actions_campaign_window`). Upgrade path: a partial index on
 * linkedin_actions(workspace_id, recorded_at) WHERE recorded_at IS NOT NULL,
 * built CONCURRENTLY, if workspace-wide exports show up as slow.
 */
async function aggregate(
  db: Db,
  scope: Scope,
  sets: ReadonlyArray<readonly GroupKey[]>
): Promise<AggregateRow[]> {
  const { workspaceId, range } = scope;
  const messageKinds = sqlList(COUNTED_MESSAGE_KINDS);
  const params: unknown[] = [];

  // LinkedIn facts. Placeholders are pushed in textual order.
  params.push(range.timezone, scope.ownerUserId, workspaceId, range.startsAt, range.endsAt);
  let linkedinFilter = '';
  if (scope.seatKey) {
    linkedinFilter += ' AND a.seat_key=?';
    params.push(scope.seatKey);
  }
  if (scope.campaignId) {
    linkedinFilter += ' AND a.campaign_id=?';
    params.push(scope.campaignId);
  }
  const linkedinFacts = `
    SELECT
      TO_CHAR(a.recorded_at AT TIME ZONE ?, 'YYYY-MM-DD') AS day,
      COALESCE(a.queued_by_user_id, s.owner_user_id, c.owner_user_id, ap.approved_by, ?::text) AS user_id,
      a.campaign_id AS campaign_id,
      a.kind AS kind,
      a.status AS status,
      a.status IN ('sent','accepted','replied') AS done,
      (a.kind IN (${messageKinds}) AND a.status IN ('sent','accepted','replied')) AS messaged,
      a.status='replied' AS replied,
      FALSE AS bounced,
      COALESCE('contact:' || m.contact_id, 'profile:' || lower(a.target_ref)) AS lead_key
    FROM linkedin_actions a
    LEFT JOIN linkedin_seats s ON s.workspace_id=a.workspace_id AND s.seat_key=a.seat_key
    LEFT JOIN linkedin_campaigns c ON c.workspace_id=a.workspace_id AND c.id=a.campaign_id
    LEFT JOIN linkedin_action_approvals ap ON ap.workspace_id=a.workspace_id AND ap.action_id=a.id
    LEFT JOIN linkedin_campaign_members m ON m.workspace_id=a.workspace_id AND m.id=a.campaign_member_id
    WHERE a.workspace_id=?
      AND a.recorded_at >= ?::timestamptz AND a.recorded_at < ?::timestamptz
      AND a.status IN ('sent','accepted','replied','declined')${linkedinFilter}`;

  // Email facts -- omitted entirely under a seat filter, because no LinkedIn
  // account sends email and a zero would claim it had been counted.
  let emailFacts = '';
  if (!scope.seatKey) {
    params.push(range.timezone, scope.ownerUserId, workspaceId, range.startsAt, range.endsAt);
    let emailFilter = '';
    if (scope.campaignId) {
      emailFilter = ' AND ca.campaign_id=?';
      params.push(scope.campaignId);
    }
    emailFacts = `
    UNION ALL
    SELECT
      TO_CHAR(ca.completed_at AT TIME ZONE ?, 'YYYY-MM-DD'),
      COALESCE(c.owner_user_id, ap.approved_by, ?::text),
      ca.campaign_id,
      'email',
      ca.status,
      TRUE,
      TRUE,
      COALESCE(ev.replied, FALSE),
      COALESCE(ev.bounced, FALSE),
      'contact:' || ca.contact_id
    FROM linkedin_campaign_channel_actions ca
    LEFT JOIN linkedin_campaigns c ON c.workspace_id=ca.workspace_id AND c.id=ca.campaign_id
    LEFT JOIN linkedin_campaign_email_approvals ap ON ap.workspace_id=ca.workspace_id AND ap.action_id=ca.id
    LEFT JOIN LATERAL (
      SELECT BOOL_OR(e.event_kind=${sqlList([EMAIL_REPLY_EVENT_KIND])}) AS replied,
             BOOL_OR(e.event_kind=${sqlList([EMAIL_BOUNCE_EVENT_KIND])}) AS bounced
      FROM linkedin_campaign_email_events e
      WHERE e.workspace_id=ca.workspace_id AND e.channel_action_id=ca.id
    ) ev ON TRUE
    WHERE ca.workspace_id=? AND ca.kind='email' AND ca.status='sent'
      AND ca.completed_at >= ?::timestamptz AND ca.completed_at < ?::timestamptz${emailFilter}`;
  }

  const used = new Set(sets.flat());
  const groupingColumns = GROUP_KEYS.map((key) =>
    used.has(key)
      ? `GROUPING(f.${key})::int AS g_${key}, f.${key} AS ${key}`
      : `1 AS g_${key}, NULL::text AS ${key}`
  ).join(',\n      ');
  const groupingSets = sets.map((set) => `(${set.map((key) => `f.${key}`).join(', ')})`).join(', ');

  return db
    .prepare(
      `
    WITH facts AS (${linkedinFacts}${emailFacts}
    )
    SELECT
      ${groupingColumns},
      COUNT(*) FILTER (WHERE f.kind='invite')::int AS invites_sent,
      COUNT(*) FILTER (WHERE f.kind='invite' AND f.status IN ('accepted','replied'))::int AS invites_accepted,
      COUNT(*) FILTER (WHERE f.kind IN (${messageKinds}) AND f.kind <> 'inmail' AND f.done)::int AS messages_sent,
      COUNT(*) FILTER (WHERE f.kind='inmail' AND f.done)::int AS inmails_sent,
      COUNT(*) FILTER (WHERE f.kind='email')::int AS emails_sent,
      COUNT(*) FILTER (WHERE f.kind='email' AND f.bounced)::int AS emails_bounced,
      COUNT(DISTINCT f.lead_key) FILTER (WHERE f.messaged)::int AS messaged_leads,
      COUNT(DISTINCT f.lead_key) FILTER (WHERE f.replied)::int AS replies,
      COUNT(DISTINCT f.lead_key) FILTER (WHERE f.messaged AND f.replied)::int AS replied_after_message,
      COUNT(*) FILTER (WHERE f.kind='follow' AND f.done)::int AS follows,
      COUNT(*) FILTER (WHERE f.kind='like' AND f.done)::int AS likes,
      COUNT(*) FILTER (WHERE f.kind='endorse' AND f.done)::int AS endorsements,
      COUNT(*) FILTER (WHERE f.kind='profile_view' AND f.done)::int AS profile_views
    FROM facts f
    GROUP BY GROUPING SETS (${groupingSets})
  `
    )
    .all<AggregateRow>(...params);
}

const ZERO: RepMetrics = {
  invitesSent: 0,
  invitesAccepted: 0,
  acceptanceRate: null,
  messagesSent: 0,
  inmailsSent: 0,
  emailsSent: 0,
  emailsBounced: 0,
  messagedLeads: 0,
  replies: 0,
  repliedAfterMessage: 0,
  replyRate: null,
  follows: 0,
  likes: 0,
  endorsements: 0,
  profileViews: 0
};

function metricsOf(row: AggregateRow | undefined): RepMetrics {
  if (!row) return { ...ZERO };
  const invitesSent = Number(row.invites_sent);
  const invitesAccepted = Number(row.invites_accepted);
  const messagedLeads = Number(row.messaged_leads);
  const repliedAfterMessage = Number(row.replied_after_message);
  return {
    invitesSent,
    invitesAccepted,
    // Same rows on both sides of each ratio, so neither can exceed 1.
    acceptanceRate: invitesSent === 0 ? null : invitesAccepted / invitesSent,
    messagesSent: Number(row.messages_sent),
    inmailsSent: Number(row.inmails_sent),
    emailsSent: Number(row.emails_sent),
    emailsBounced: Number(row.emails_bounced),
    messagedLeads,
    replies: Number(row.replies),
    repliedAfterMessage,
    replyRate: messagedLeads === 0 ? null : repliedAfterMessage / messagedLeads,
    follows: Number(row.follows),
    likes: Number(row.likes),
    endorsements: Number(row.endorsements),
    profileViews: Number(row.profile_views)
  };
}

/** Rows of exactly this grouping set: the listed keys grouped, every other key rolled up. */
function rowsOf(rows: readonly AggregateRow[], keys: readonly GroupKey[]): AggregateRow[] {
  return rows.filter((row) =>
    GROUP_KEYS.every((key) => Number(row[`g_${key}`]) === (keys.includes(key) ? 0 : 1))
  );
}

/* ---------------------------------------------------------------------------
 * Entry points.
 * ------------------------------------------------------------------------ */

interface PreparedScope {
  scope: Scope;
  members: WorkspaceMembers;
}

/** Range, filters and members, validated -- every filter must belong to this workspace. */
async function prepareScope(
  db: Db,
  workspaceId: string,
  query: ReportQuery,
  now: Date
): Promise<PreparedScope> {
  const timezone = await reportTimezone(db, workspaceId);
  const range = resolveReportRange(query, timezone, now);
  if (query.seatKey) {
    const seat = await db
      .prepare('SELECT 1 AS found FROM linkedin_seats WHERE workspace_id=? AND seat_key=?')
      .get<{ found: number }>(workspaceId, query.seatKey);
    if (!seat)
      throw new RepReportError('That LinkedIn account is not configured for this workspace.', 404);
  }
  if (query.campaignId) {
    const campaign = await db
      .prepare('SELECT 1 AS found FROM linkedin_campaigns WHERE workspace_id=? AND id=?')
      .get<{ found: number }>(workspaceId, query.campaignId);
    if (!campaign) throw new RepReportError('Campaign not found.', 404);
  }
  const members = await workspaceMembers(db, workspaceId);
  return {
    scope: {
      workspaceId,
      range,
      ownerUserId: members.ownerUserId,
      seatKey: query.seatKey,
      campaignId: query.campaignId
    },
    members
  };
}

const STATUS_ORDER: Record<MemberStatus, number> = { current: 0, former: 1, unattributed: 2 };

/** One row per current member (zeros included) plus every other person the range attributes work to. */
async function memberRows(
  db: Db,
  members: WorkspaceMembers,
  rows: readonly AggregateRow[]
): Promise<ReportMemberRow[]> {
  const byUser = new Map(rows.map((row) => [row.user_id, row]));
  const formerIds = rows
    .map((row) => row.user_id)
    .filter((userId): userId is string => userId !== null && !members.current.has(userId));
  const formerNames = await namesFor(db, formerIds);
  const out: ReportMemberRow[] = [];
  for (const [userId, name] of members.current)
    out.push({ userId, name, status: 'current', ...metricsOf(byUser.get(userId)) });
  for (const userId of formerIds)
    out.push({
      userId,
      name: formerNames.get(userId) ?? 'Deleted account',
      status: 'former',
      ...metricsOf(byUser.get(userId))
    });
  const unattributed = byUser.get(null);
  if (unattributed)
    out.push({
      userId: null,
      name: 'Unattributed',
      status: 'unattributed',
      ...metricsOf(unattributed)
    });
  return out.sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      a.name.localeCompare(b.name) ||
      String(a.userId).localeCompare(String(b.userId))
  );
}

/**
 * The analytics screen's one read: totals, the daily series, the per-campaign
 * table and the per-rep table, for one range and one set of filters.
 */
export async function repReport(
  db: Db,
  workspaceId: string,
  query: ReportQuery,
  now: Date
): Promise<RepReport> {
  const { scope, members } = await prepareScope(db, workspaceId, query, now);
  const rows = await aggregate(db, scope, [[], ['day'], ['campaign_id'], ['user_id']]);

  const byDay = new Map(rowsOf(rows, ['day']).map((row) => [row.day, row]));
  const days = rangeDays(scope.range).map((day) => ({ ...day, ...metricsOf(byDay.get(day.date)) }));

  const campaignRows = rowsOf(rows, ['campaign_id']);
  const campaignIds = campaignRows
    .map((row) => row.campaign_id)
    .filter((value): value is string => value !== null);
  const campaignMeta = new Map(
    (campaignIds.length
      ? await db
          .prepare(
            'SELECT id, name, status FROM linkedin_campaigns WHERE workspace_id=? AND id = ANY(?::text[])'
          )
          .all<{ id: string; name: string; status: string }>(workspaceId, campaignIds)
      : []
    ).map((row) => [row.id, row])
  );
  const campaigns: ReportCampaignRow[] = campaignRows
    .map((row) => ({
      campaignId: row.campaign_id,
      name: row.campaign_id ? (campaignMeta.get(row.campaign_id)?.name ?? null) : null,
      status: row.campaign_id ? (campaignMeta.get(row.campaign_id)?.status ?? null) : null,
      ...metricsOf(row)
    }))
    .sort(
      (a, b) =>
        Number(a.campaignId === null) - Number(b.campaignId === null) ||
        String(a.name ?? a.campaignId).localeCompare(String(b.name ?? b.campaignId))
    );

  return {
    range: scope.range,
    filters: {
      seatKey: scope.seatKey ?? null,
      campaignId: scope.campaignId ?? null,
      emailIncluded: !scope.seatKey
    },
    total: metricsOf(rowsOf(rows, [])[0]),
    days,
    campaigns,
    members: await memberRows(db, members, rowsOf(rows, ['user_id'])),
    limits: { maxDays: MAX_REPORT_DAYS, maxTeamExportRows: MAX_TEAM_EXPORT_ROWS }
  };
}

/* ---------------------------------------------------------------------------
 * CSV.
 * ------------------------------------------------------------------------ */

const METRIC_COLUMNS: ReadonlyArray<readonly [keyof RepMetrics, string]> = [
  ['invitesSent', 'invites_sent'],
  ['invitesAccepted', 'invites_accepted'],
  ['acceptanceRate', 'acceptance_rate'],
  ['messagesSent', 'messages_sent'],
  ['inmailsSent', 'inmails_sent'],
  ['emailsSent', 'emails_sent'],
  ['emailsBounced', 'emails_bounced'],
  ['messagedLeads', 'messaged_leads'],
  ['replies', 'replies'],
  ['repliedAfterMessage', 'replied_after_message'],
  ['replyRate', 'reply_rate'],
  ['follows', 'follows'],
  ['likes', 'likes'],
  ['endorsements', 'endorsements'],
  ['profileViews', 'profile_views']
];

/** Rates as a fraction to four places; an empty cell, not 0, when there was no denominator. */
function metricCells(metrics: RepMetrics): string[] {
  return METRIC_COLUMNS.map(([key]) => {
    const value = metrics[key];
    if (value === null) return '';
    return key === 'acceptanceRate' || key === 'replyRate' ? value.toFixed(4) : String(value);
  });
}

/** Every cell through the shared formula-safe serializer. */
function toCsv(header: readonly string[], rows: ReadonlyArray<readonly unknown[]>): string {
  return `${[header, ...rows].map((row) => row.map(safeCsvCell).join(',')).join('\n')}\n`;
}

function fileSlug(value: string, fallback: string): string {
  return (
    value
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 60) || fallback
  );
}

/** `from` inclusive and `to` exclusive, said in the filename itself: "before" is the exclusive edge. */
function rangeFilename(prefix: string, range: ReportRange): string {
  return `${prefix}_from-${range.from}_before-${range.to}.csv`;
}

const DAY_HEADER = ['date', 'starts_at', 'ends_at', ...METRIC_COLUMNS.map(([, column]) => column)];

/** Workspace daily stats: one row per local day in the range, honouring seat and campaign filters. */
export async function dailyStatsCsv(
  db: Db,
  workspaceId: string,
  query: ReportQuery,
  now: Date
): Promise<CsvExport> {
  const { scope } = await prepareScope(db, workspaceId, query, now);
  const rows = await aggregate(db, scope, [['day']]);
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const lines = rangeDays(scope.range).map((day) => [
    day.date,
    day.startsAt,
    day.endsAt,
    ...metricCells(metricsOf(byDay.get(day.date)))
  ]);
  return {
    filename: rangeFilename('trevra-daily-stats', scope.range),
    csv: toCsv(DAY_HEADER, lines),
    rows: lines.length
  };
}

/** One campaign's stats, one row per local day. Null when the campaign is not this workspace's. */
export async function campaignStatsCsv(
  db: Db,
  workspaceId: string,
  campaignId: string,
  query: Omit<ReportQuery, 'campaignId'>,
  now: Date
): Promise<CsvExport | null> {
  const campaign = await db
    .prepare('SELECT id, name FROM linkedin_campaigns WHERE workspace_id=? AND id=?')
    .get<{ id: string; name: string }>(workspaceId, campaignId);
  if (!campaign) return null;
  const { scope } = await prepareScope(db, workspaceId, { ...query, campaignId }, now);
  const rows = await aggregate(db, scope, [['day']]);
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const lines = rangeDays(scope.range).map((day) => [
    campaign.id,
    campaign.name,
    day.date,
    day.startsAt,
    day.endsAt,
    ...metricCells(metricsOf(byDay.get(day.date)))
  ]);
  return {
    filename: rangeFilename(`trevra-campaign-${fileSlug(campaign.name, 'campaign')}`, scope.range),
    csv: toCsv(['campaign_id', 'campaign_name', ...DAY_HEADER], lines),
    rows: lines.length
  };
}

/**
 * The team export: one row per selected member per local day.
 *
 * Members must be people this workspace can attribute work to -- a current
 * member, or someone the range attributes work to (a former member). Anyone
 * else is refused, not silently dropped. The row cap is checked before any
 * ledger is read, against the exact row count the file would have.
 */
export async function teamStatsCsv(
  db: Db,
  workspaceId: string,
  query: ReportQuery & { memberIds: readonly string[] },
  now: Date
): Promise<CsvExport> {
  const memberIds = [...new Set(query.memberIds.map((value) => value.trim()).filter(Boolean))];
  if (memberIds.length === 0) throw new RepReportError('Select at least one member to export.');
  const { scope, members } = await prepareScope(db, workspaceId, query, now);
  const rowCount = memberIds.length * scope.range.days;
  if (rowCount > MAX_TEAM_EXPORT_ROWS)
    throw new RepReportError(
      `This export would be ${rowCount.toLocaleString('en-US')} rows (${memberIds.length} members x ${scope.range.days} days); the limit is ${MAX_TEAM_EXPORT_ROWS.toLocaleString('en-US')}. Narrow the range or select fewer members.`
    );
  const rows = await aggregate(db, scope, [['user_id'], ['user_id', 'day']]);
  const attributed = new Set(rowsOf(rows, ['user_id']).map((row) => row.user_id));
  const unknown = memberIds.filter(
    (userId) => !members.current.has(userId) && !attributed.has(userId)
  );
  if (unknown.length > 0)
    throw new RepReportError(
      `${unknown.length === 1 ? 'One selected person is' : `${unknown.length} selected people are`} not a member of this workspace and has no attributed work in this range.`
    );
  const formerNames = await namesFor(
    db,
    memberIds.filter((userId) => !members.current.has(userId))
  );
  const byKey = new Map(
    rowsOf(rows, ['user_id', 'day']).map((row) => [`${row.user_id}\u0000${row.day}`, row])
  );
  const selected = memberIds
    .map((userId) => {
      const current = members.current.get(userId);
      return {
        userId,
        name: current ?? formerNames.get(userId) ?? 'Deleted account',
        status: current === undefined ? 'former' : 'current'
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId));
  const days = rangeDays(scope.range);
  const lines: unknown[][] = [];
  for (const member of selected)
    for (const day of days)
      lines.push([
        member.userId,
        member.name,
        member.status,
        day.date,
        day.startsAt,
        day.endsAt,
        ...metricCells(metricsOf(byKey.get(`${member.userId}\u0000${day.date}`)))
      ]);
  return {
    filename: rangeFilename('trevra-team-stats', scope.range),
    csv: toCsv(['member_id', 'member_name', 'member_status', ...DAY_HEADER], lines),
    rows: lines.length
  };
}
