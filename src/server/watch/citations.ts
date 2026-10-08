import { createHash } from 'node:crypto';
import { z } from 'zod';
import { normalizeAccountDomain } from '../accounts/store.js';
import { id, type Db } from '../db.js';
import { createCaptureSource, getWorkspaceCaptureSource } from '../lead-capture/sources.js';
import {
  CITATION_PREPARATION_PREFIX,
  CITATION_SOURCE_KIND,
  LeadCaptureError,
  type CaptureSourceRecord
} from '../lead-capture/types.js';
import { SENTIMENT_VERSION } from './sentiment.js';
import {
  AI_ANSWER_PLATFORM,
  getWatchMention,
  type BrandWatch,
  type WatchMention
} from './store.js';

/**
 * AI-answer citations: content-free samples of whether an AI engine cited the
 * founder's own site for a tracked prompt. A sampler (Beseam, or anything that
 * can sign) posts one sample per engine, prompt and run.
 *
 * Only TRANSITIONS become brand-watch mentions: a first citation or a regained
 * one is `gained`, a drop is `lost`. A repeat (`kept`) or a run that never
 * cited the brand (`absent`) is state, not news, and only updates
 * `ai_citation_samples`. These mentions are written here rather than through
 * `recordWatchMentions`, so they never touch the sentiment trend: a citation
 * is not a sentiment.
 *
 * Nothing here stores answer text or prompt text. `citationSampleSchema` is
 * strict, so a body carrying either is refused before it reaches storage.
 */

export { AI_ANSWER_PLATFORM, CITATION_PREPARATION_PREFIX };
export const AI_ANSWER_ENGINES = [
  'chatgpt',
  'google_ai_mode',
  'gemini',
  'perplexity',
  'copilot',
  'claude',
  'google_search'
] as const;
export type AiAnswerEngine = (typeof AI_ANSWER_ENGINES)[number];
export const AI_ANSWER_ENGINE_LABELS: Record<AiAnswerEngine, string> = {
  chatgpt: 'ChatGPT',
  google_ai_mode: 'Google AI Mode',
  gemini: 'Gemini',
  perplexity: 'Perplexity',
  copilot: 'Copilot',
  claude: 'Claude',
  google_search: 'Google Search'
};

const MAX_OWNED_DOMAINS = 20;
const MAX_CITED_URLS = 20;
const FUTURE_SKEW_MS = 5 * 60_000;
const RETENTION_MONTHS = 13;
// A citation source whose watch is gone is closed after this grace period. The
// grace covers the gap between createCaptureSource committing and the link row
// being written; a retry inside it reuses the source through its
// preparation key.
const ORPHAN_GRACE_MS = 60 * 60_000;

export const citationSampleSchema = z
  .object({
    sampleId: z
      .string()
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/,
        'sampleId must be 1-120 letters, digits, dots, underscores, colons or hyphens'
      ),
    engine: z.enum(AI_ANSWER_ENGINES),
    promptRef: z
      .string()
      .regex(
        /^(id:[A-Za-z0-9][A-Za-z0-9._:-]{0,119}|sha256:[a-f0-9]{64})$/,
        'promptRef must be id:<label> or sha256:<64 lowercase hex characters>'
      ),
    answeredAt: z.string().datetime({ offset: true }),
    brandCited: z.boolean(),
    citedUrls: z.array(z.string().trim().min(1).max(2048)).max(MAX_CITED_URLS).default([]),
    position: z.number().int().min(1).max(100).nullable().default(null)
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.brandCited && (value.citedUrls.length > 0 || value.position !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['brandCited'],
        message: 'A sample that did not cite the brand carries no cited URLs or position'
      });
    }
  });
export type CitationSample = z.infer<typeof citationSampleSchema>;

export type CitationChange = 'gained' | 'lost' | 'kept' | 'absent' | 'stale';

export interface CitationSourceLink {
  watchId: string;
  workspaceId: string;
  captureSourceId: string;
  ownedDomains: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CitationSourceView {
  watchId: string;
  sourceId: string;
  status: 'active' | 'disabled';
  ownedDomains: string[];
  lastSeenAt: string | null;
  acceptedCount: number;
  rejectedCount: number;
  latestAnsweredAt: string | null;
}

interface LinkRow {
  watch_id: string;
  workspace_id: string;
  capture_source_id: string;
  owned_domains: string[];
  created_at: string;
  updated_at: string;
}

function toLink(row: LinkRow): CitationSourceLink {
  return {
    watchId: row.watch_id,
    workspaceId: row.workspace_id,
    captureSourceId: row.capture_source_id,
    ownedDomains: row.owned_domains ?? [],
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString()
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeOwnedDomains(raw: readonly string[]): string[] {
  const domains = new Set<string>();
  for (const entry of raw) {
    const domain = normalizeAccountDomain(entry);
    if (!domain)
      throw new LeadCaptureError(`"${String(entry).slice(0, 80)}" is not a domain.`, 400);
    domains.add(domain);
  }
  if (domains.size === 0 || domains.size > MAX_OWNED_DOMAINS)
    throw new LeadCaptureError(`List between 1 and ${MAX_OWNED_DOMAINS} domains you own.`, 400);
  return [...domains].sort();
}

/**
 * Exact host or a true subdomain of an owned domain. `trevra.com.evil.io` and
 * `eviltrevra.com` both fail: the match is on a label boundary, never on a
 * substring. Userinfo is refused because `https://trevra.com@evil.io/` reads
 * as Trevra to a person and as evil.io to the parser.
 */
export function citedUrlWithinOwnedDomains(url: string, ownedDomains: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.replace(/\.+$/, '').toLowerCase();
  return ownedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** Origin and path only: query strings and fragments carry tracking ids, not citations. */
export function sanitizeCitedUrl(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

export async function getCitationLinkForWatch(
  db: Db,
  workspaceId: string,
  watchId: string
): Promise<CitationSourceLink | null> {
  const row = await db
    .prepare('SELECT * FROM brand_watch_citation_sources WHERE workspace_id=? AND watch_id=?')
    .get<LinkRow>(workspaceId, watchId);
  return row ? toLink(row) : null;
}

export async function getCitationLinkForSource(
  db: Db,
  source: CaptureSourceRecord
): Promise<CitationSourceLink | null> {
  const row = await db
    .prepare(
      'SELECT * FROM brand_watch_citation_sources WHERE workspace_id=? AND capture_source_id=?'
    )
    .get<LinkRow>(source.workspaceId, source.id);
  return row ? toLink(row) : null;
}

export async function citationSourceView(
  db: Db,
  workspaceId: string,
  watchId: string
): Promise<CitationSourceView | null> {
  const link = await getCitationLinkForWatch(db, workspaceId, watchId);
  if (!link) return null;
  const source = await getWorkspaceCaptureSource(db, workspaceId, link.captureSourceId);
  if (!source) return null;
  const latest = await db
    .prepare(
      `SELECT TO_CHAR(MAX(answered_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS latest
       FROM ai_citation_samples WHERE workspace_id=? AND watch_id=?`
    )
    .get<{ latest: string | null }>(workspaceId, watchId);
  return {
    watchId,
    sourceId: source.id,
    status: source.status,
    ownedDomains: link.ownedDomains,
    lastSeenAt: source.lastSeenAt,
    acceptedCount: source.acceptedCount,
    rejectedCount: source.rejectedCount,
    latestAnsweredAt: latest?.latest ?? null
  };
}

/**
 * Bind a watch to its own signed citation source, or update its owned domains.
 * The secret is returned only when the link row is created by this call, so a
 * second connect (or a concurrent one that lost the race) never re-reveals it;
 * rotation goes through the existing capture-source rotate route.
 *
 * Two steps, not one transaction: createCaptureSource opens its own
 * transaction and `Db` does not nest them. A crash between the two leaves an
 * unlinked source that a retry reuses (same preparation key) and that
 * `pruneCitationSamples` closes after ORPHAN_GRACE_MS.
 */
export async function connectCitationSource(
  db: Db,
  input: {
    workspaceId: string;
    actorUserId: string;
    watch: BrandWatch;
    ownedDomains: readonly string[];
  },
  now: Date = new Date()
): Promise<{
  link: CitationSourceLink;
  source: CaptureSourceRecord;
  secret: string | null;
  created: boolean;
}> {
  if (input.watch.workspaceId !== input.workspaceId)
    throw new LeadCaptureError('Watch not found', 404);
  const ownedDomains = normalizeOwnedDomains(input.ownedDomains);
  const at = now.toISOString();

  const updateExisting = async (): Promise<CitationSourceLink | null> => {
    const row = await db
      .prepare(
        `UPDATE brand_watch_citation_sources SET owned_domains=?, updated_at=?
         WHERE workspace_id=? AND watch_id=? RETURNING *`
      )
      .get<LinkRow>(ownedDomains, at, input.workspaceId, input.watch.id);
    return row ? toLink(row) : null;
  };
  const withSource = async (link: CitationSourceLink) => {
    const source = await getWorkspaceCaptureSource(db, input.workspaceId, link.captureSourceId);
    if (!source) throw new Error('Citation source link points at a missing capture source');
    return { link, source, secret: null, created: false };
  };

  const existing = await updateExisting();
  if (existing) return withSource(existing);

  const attempt = async () => {
    const created = await createCaptureSource(
      db,
      {
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        name: `AI answers · ${input.watch.name}`.slice(0, 120),
        kind: CITATION_SOURCE_KIND,
        preparationKey: `${CITATION_PREPARATION_PREFIX}${input.watch.id}`,
        preparationHash: sha256(input.watch.id)
      },
      now
    );
    const inserted = await db
      .prepare(
        `INSERT INTO brand_watch_citation_sources
           (watch_id, workspace_id, capture_source_id, owned_domains, created_at, updated_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT (watch_id) DO NOTHING
         RETURNING *`
      )
      .get<LinkRow>(input.watch.id, input.workspaceId, created.source.id, ownedDomains, at, at);
    return { created, inserted };
  };
  let result;
  try {
    result = await attempt();
  } catch (error) {
    // The prune closer deleted the orphaned source createCaptureSource just
    // reused; the retry's create makes a fresh one.
    if ((error as { code?: unknown }).code !== '23503') throw error;
    result = await attempt();
  }
  const { created, inserted } = result;
  if (!inserted) {
    const raced = await updateExisting();
    if (!raced) throw new Error('Citation source link vanished during connect');
    return withSource(raced);
  }
  return {
    link: toLink(inserted),
    source: created.source,
    secret: created.secret,
    created: true
  };
}

function decideChange(previouslyCited: boolean | null, cited: boolean): CitationChange {
  if (previouslyCited === null) return cited ? 'gained' : 'absent';
  if (previouslyCited) return cited ? 'kept' : 'lost';
  return cited ? 'gained' : 'absent';
}

function promptLabel(promptRef: string): string {
  return promptRef.startsWith('id:')
    ? `“${promptRef.slice(3)}”`
    : `#${promptRef.slice('sha256:'.length, 'sha256:'.length + 8)}`;
}

/**
 * Record one sample and, for a gained/lost transition, one immutable mention.
 *
 * The comparison is against the LATEST earlier non-stale sample for the same
 * engine and prompt. A sample answered at or before that latest one is
 * `stale`: it is stored for replay and audit but changes nothing.
 *
 * lc-debt: a late sample never rewrites history. If samplers deliver out of
 * order, the transition it would have marked is lost rather than re-derived;
 * the upgrade path is recomputing `change` for the (engine, prompt) series
 * after any out-of-order insert, which also means retracting mentions.
 */
export async function recordCitationSample(
  db: Db,
  input: {
    link: CitationSourceLink;
    idempotencyKey: string;
    payloadHash: string;
    sample: CitationSample;
  },
  now: Date = new Date()
): Promise<{ change: CitationChange; mention: WatchMention | null; duplicate: boolean }> {
  const { link, sample } = input;
  const at = now.toISOString();

  const outcome = await db.transaction(async (tx) => {
    await tx
      .prepare('SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0))')
      .get(`${link.workspaceId}:citations:${link.watchId}`);
    const replay = await tx
      .prepare(
        `SELECT payload_hash, change, mention_id FROM ai_citation_samples
         WHERE workspace_id=?
           AND ((capture_source_id=? AND idempotency_key=?) OR (watch_id=? AND sample_id=?))
         LIMIT 1`
      )
      .get<{ payload_hash: string; change: CitationChange; mention_id: string | null }>(
        link.workspaceId,
        link.captureSourceId,
        input.idempotencyKey,
        link.watchId,
        sample.sampleId
      );
    if (replay) {
      if (replay.payload_hash !== input.payloadHash)
        throw new LeadCaptureError(
          'This idempotency key or sampleId was already used for a different sample.',
          409
        );
      return { change: replay.change, mentionId: replay.mention_id, duplicate: true };
    }

    // Validated only for a NEW sample: a retry of an accepted sample must replay
    // even if the owner has since narrowed ownedDomains or the window has passed.
    if (new Date(sample.answeredAt).getTime() > now.getTime() + FUTURE_SKEW_MS)
      throw new LeadCaptureError('answeredAt is in the future', 400);
    const oldest = await tx
      .prepare(`SELECT (?::timestamptz < ?::timestamptz - make_interval(months => ?)) AS too_old`)
      .get<{ too_old: boolean }>(sample.answeredAt, now.toISOString(), RETENTION_MONTHS);
    if (oldest?.too_old)
      throw new LeadCaptureError('answeredAt is older than the retention window', 400);
    if (sample.citedUrls.some((url) => !citedUrlWithinOwnedDomains(url, link.ownedDomains)))
      throw new LeadCaptureError(
        'citedUrls may only contain http(s) URLs on the domains connected to this watch',
        400
      );
    const citedUrls = [...new Set(sample.citedUrls.map(sanitizeCitedUrl))];

    const latest = await tx
      .prepare(
        `SELECT brand_cited, (answered_at >= ?::timestamptz) AS not_older
         FROM ai_citation_samples
         WHERE workspace_id=? AND watch_id=? AND engine=? AND prompt_ref=? AND change <> 'stale'
         ORDER BY answered_at DESC
         LIMIT 1`
      )
      .get<{ brand_cited: boolean; not_older: boolean }>(
        sample.answeredAt,
        link.workspaceId,
        link.watchId,
        sample.engine,
        sample.promptRef
      );
    const change: CitationChange = latest?.not_older
      ? 'stale'
      : decideChange(latest ? latest.brand_cited : null, sample.brandCited);

    let mentionId: string | null = null;
    if (change === 'gained' || change === 'lost') {
      const engineLabel = AI_ANSWER_ENGINE_LABELS[sample.engine];
      const prompt = promptLabel(sample.promptRef);
      const externalId = `${sample.engine}:${sample.promptRef}:${sample.sampleId}`;
      const metadata = {
        source: AI_ANSWER_PLATFORM,
        change,
        engine: sample.engine,
        engineLabel,
        promptRef: sample.promptRef,
        brandCited: sample.brandCited,
        position: sample.position,
        citedUrls,
        answeredAt: sample.answeredAt,
        sampleId: sample.sampleId
      };
      const row = await tx
        .prepare(
          `INSERT INTO brand_watch_mentions (
             id, workspace_id, watch_id, platform, external_id, url, title, content,
             sentiment_label, sentiment_score, sentiment_span, sentiment_version, content_hash,
             metadata_json, mention_created_at, first_seen_at, last_seen_at
           ) VALUES (?,?,?,?,?,?,?,'','neutral',0,'',?,?,?::jsonb,?,?,?)
           ON CONFLICT (watch_id, platform, external_id) DO UPDATE SET
             last_seen_at = excluded.last_seen_at
           RETURNING id`
        )
        .get<{ id: string }>(
          id('bwm'),
          link.workspaceId,
          link.watchId,
          AI_ANSWER_PLATFORM,
          externalId,
          citedUrls[0] ?? `https://${link.ownedDomains[0]}/`,
          change === 'gained'
            ? `Cited by ${engineLabel} for prompt ${prompt}`
            : `No longer cited by ${engineLabel} for prompt ${prompt}`,
          SENTIMENT_VERSION,
          sha256(`${AI_ANSWER_PLATFORM}:${externalId}`),
          JSON.stringify(metadata),
          sample.answeredAt,
          at,
          at
        );
      mentionId = row?.id ?? null;
    }

    await tx
      .prepare(
        `INSERT INTO ai_citation_samples (
           id, workspace_id, watch_id, capture_source_id, idempotency_key, payload_hash,
           sample_id, engine, prompt_ref, answered_at, brand_cited, change, mention_id, received_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id('acs'),
        link.workspaceId,
        link.watchId,
        link.captureSourceId,
        input.idempotencyKey,
        input.payloadHash,
        sample.sampleId,
        sample.engine,
        sample.promptRef,
        sample.answeredAt,
        sample.brandCited,
        change,
        mentionId,
        at
      );
    return { change, mentionId, duplicate: false };
  });

  const mention = outcome.mentionId
    ? await getWatchMention(db, link.workspaceId, outcome.mentionId)
    : null;
  return { change: outcome.change, mention, duplicate: outcome.duplicate };
}

/**
 * Retention and the orphan closer, run from the worker cycle. Samples are kept
 * 13 months by receipt time. A citation source whose watch was deleted (the
 * link row cascades away, the capture source does not) is deleted once it is
 * older than ORPHAN_GRACE_MS, which also removes its sealed secrets through
 * the capture_source_secrets cascade.
 */
export async function pruneCitationSamples(db: Db, now: Date = new Date()): Promise<void> {
  const orphanCutoff = new Date(now.getTime() - ORPHAN_GRACE_MS).toISOString();
  try {
    await db
      .prepare(
        'DELETE FROM ai_citation_samples WHERE received_at < ?::timestamptz - make_interval(months => ?)'
      )
      .run(now.toISOString(), RETENTION_MONTHS);
    await db
      .prepare(
        `DELETE FROM capture_sources s
         WHERE s.kind = ? AND s.created_at < ?::timestamptz
           AND NOT EXISTS (
             SELECT 1 FROM brand_watch_citation_sources l
             WHERE l.workspace_id = s.workspace_id AND l.capture_source_id = s.id
           )`
      )
      .run(CITATION_SOURCE_KIND, orphanCutoff);
  } catch (error) {
    console.error('AI-answer citation prune failed', error);
  }
}
