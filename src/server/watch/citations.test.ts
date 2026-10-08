import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { listCaptureSources } from '../lead-capture/sources.js';
import { LeadCaptureError } from '../lead-capture/types.js';
import {
  citationSampleSchema,
  connectCitationSource,
  pruneCitationSamples,
  recordCitationSample,
  type CitationSample,
  type CitationSourceLink
} from './citations.js';
import { createCaptureSource } from '../lead-capture/sources.js';
import { createWatch, listWatchMentions, type BrandWatch } from './store.js';

const WORKSPACE = 'ws_ai_citations';
const USER = 'usr_ai_citations';
const NOW = new Date('2026-10-06T09:00:00.000Z');
let db: Db;
let watch: BrandWatch;
let link: CitationSourceLink;

function sample(overrides: Partial<CitationSample> = {}): CitationSample {
  return citationSampleSchema.parse({
    sampleId: 'beseam-0001',
    engine: 'chatgpt',
    promptRef: 'id:best-gtm-ledger',
    answeredAt: '2026-10-02T08:00:00.000Z',
    brandCited: true,
    citedUrls: ['https://trevra.com/pricing?utm_source=chatgpt#plans'],
    position: 2,
    ...overrides
  });
}

async function record(value: CitationSample, key = `sample-${value.sampleId}`) {
  return recordCitationSample(
    db,
    {
      link,
      idempotencyKey: key,
      payloadHash: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
      sample: value
    },
    NOW
  );
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db
    .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
    .run(WORKSPACE, 'AI citations', NOW.toISOString());
  await db
    .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
    .run(USER, WORKSPACE, 'ai-citations@trevra.test', 'Founder', NOW.toISOString());
  watch = await createWatch(
    db,
    WORKSPACE,
    { name: 'Trevra', keywords: ['trevra'], platforms: ['hackernews'], cadence: 'daily' },
    NOW
  );
  ({ link } = await connectCitationSource(
    db,
    {
      workspaceId: WORKSPACE,
      actorUserId: USER,
      watch,
      ownedDomains: ['https://www.Trevra.com/', 'docs.trevra.dev']
    },
    NOW
  ));
});

afterEach(async () => {
  // Due watches left behind would be picked up by other files' runDueBrandWatches.
  await db?.prepare('DELETE FROM brand_watches WHERE workspace_id=?').run(WORKSPACE);
  await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
  await db?.close();
});

describe('AI-answer citations', () => {
  it('connects one hidden signed source per watch and reveals its secret once', async () => {
    expect(link.ownedDomains).toEqual(['docs.trevra.dev', 'trevra.com']);
    const again = await connectCitationSource(
      db,
      { workspaceId: WORKSPACE, actorUserId: USER, watch, ownedDomains: ['trevra.com'] },
      NOW
    );
    expect(again).toMatchObject({ created: false, secret: null });
    expect(again.link.captureSourceId).toBe(link.captureSourceId);
    expect(again.link.ownedDomains).toEqual(['trevra.com']);
    const listed = await listCaptureSources(db, WORKSPACE);
    expect(listed.map((source) => source.id)).not.toContain(link.captureSourceId);
  });

  it('records a first citation as gained, a repeat as kept and a drop as lost', async () => {
    const gained = await record(sample());
    expect(gained.change).toBe('gained');
    expect(gained.mention).toMatchObject({
      platform: 'ai_answer',
      url: 'https://trevra.com/pricing',
      content: '',
      title: 'Cited by ChatGPT for prompt “best-gtm-ledger”',
      sentimentLabel: 'neutral'
    });
    expect(gained.mention?.metadata).toMatchObject({
      source: 'ai_answer',
      change: 'gained',
      engine: 'chatgpt',
      engineLabel: 'ChatGPT',
      position: 2,
      citedUrls: ['https://trevra.com/pricing']
    });
    const kept = await record(
      sample({ sampleId: 'beseam-0002', answeredAt: '2026-10-03T08:00:00.000Z' })
    );
    expect(kept).toMatchObject({ change: 'kept', mention: null });
    const lost = await record(
      sample({
        sampleId: 'beseam-0003',
        answeredAt: '2026-10-04T08:00:00.000Z',
        brandCited: false,
        citedUrls: [],
        position: null
      })
    );
    expect(lost.change).toBe('lost');
    expect(lost.mention?.title).toBe('No longer cited by ChatGPT for prompt “best-gtm-ledger”');
    const mentions = await listWatchMentions(db, WORKSPACE, watch.id, { platform: 'ai_answer' });
    expect(mentions).toHaveLength(2);
  });

  it('an older sample arriving late is stale and creates no mention', async () => {
    await record(sample({ answeredAt: '2026-10-03T08:00:00.000Z' }));
    const late = await record(
      sample({
        sampleId: 'beseam-late',
        answeredAt: '2026-10-01T08:00:00.000Z',
        brandCited: false,
        citedUrls: [],
        position: null
      })
    );
    expect(late).toMatchObject({ change: 'stale', mention: null });
    const next = await record(
      sample({ sampleId: 'beseam-0004', answeredAt: '2026-10-04T08:00:00.000Z' })
    );
    expect(next.change).toBe('kept');
    expect(
      await listWatchMentions(db, WORKSPACE, watch.id, { platform: 'ai_answer' })
    ).toHaveLength(1);
  });

  it('replays a retried sample and refuses changed content under the same sample id', async () => {
    const first = await record(sample());
    const retry = await record(sample());
    expect(retry).toMatchObject({ duplicate: true, change: 'gained' });
    expect(retry.mention?.id).toBe(first.mention?.id);
    const changed = await record(sample({ position: 5 }), 'sample-other-key').catch(
      (caught: unknown) => caught
    );
    expect(changed).toBeInstanceOf(LeadCaptureError);
    expect((changed as LeadCaptureError).status).toBe(409);
  });

  it('replays an accepted sample after ownedDomains narrows, but still validates new ones', async () => {
    await connectCitationSource(
      db,
      {
        workspaceId: WORKSPACE,
        actorUserId: USER,
        watch,
        ownedDomains: ['a.example', 'b.example']
      },
      NOW
    );
    const wide = (
      await connectCitationSource(
        db,
        {
          workspaceId: WORKSPACE,
          actorUserId: USER,
          watch,
          ownedDomains: ['a.example', 'b.example']
        },
        NOW
      )
    ).link;
    const value = sample({ citedUrls: ['https://a.example/x'] });
    const hash = createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const send = (l: CitationSourceLink, v: CitationSample, key: string, h: string) =>
      recordCitationSample(db, { link: l, idempotencyKey: key, payloadHash: h, sample: v }, NOW);
    const first = await send(wide, value, 'narrow-key', hash);
    const narrowed = (
      await connectCitationSource(
        db,
        { workspaceId: WORKSPACE, actorUserId: USER, watch, ownedDomains: ['b.example'] },
        NOW
      )
    ).link;
    const replay = await send(narrowed, value, 'narrow-key', hash);
    expect(replay).toMatchObject({ duplicate: true, change: first.change });
    expect(replay.mention?.id).toBe(first.mention?.id);
    const fresh = sample({ sampleId: 'beseam-new', citedUrls: ['https://a.example/y'] });
    const error = await send(
      narrowed,
      fresh,
      'narrow-new',
      createHash('sha256').update(JSON.stringify(fresh)).digest('hex')
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LeadCaptureError);
    expect((error as LeadCaptureError).status).toBe(400);
  });

  it('rejects lookalike and foreign cited URLs', async () => {
    for (const url of [
      'https://trevra.com.evil.io/pricing',
      'https://eviltrevra.com/',
      'https://user:pw@trevra.com/',
      'ftp://trevra.com/file'
    ]) {
      const error = await record(sample({ sampleId: 'beseam-bad', citedUrls: [url] })).catch(
        (caught: unknown) => caught
      );
      expect(error).toBeInstanceOf(LeadCaptureError);
      expect((error as LeadCaptureError).status).toBe(400);
    }
    const rows = await db
      .prepare('SELECT COUNT(*) AS count FROM ai_citation_samples WHERE watch_id=?')
      .get<{ count: string }>(watch.id);
    expect(Number(rows?.count)).toBe(0);
    const subdomain = await record(
      sample({ sampleId: 'beseam-sub', citedUrls: ['https://api.docs.trevra.dev/x'] })
    );
    expect(subdomain.change).toBe('gained');
  });

  it('accepts no answer text and no URLs on a sample that did not cite the brand', () => {
    const base = {
      sampleId: 'beseam-0001',
      engine: 'gemini',
      promptRef: `sha256:${'a'.repeat(64)}`,
      answeredAt: '2026-10-02T08:00:00.000Z',
      brandCited: false
    };
    expect(citationSampleSchema.safeParse(base).success).toBe(true);
    expect(citationSampleSchema.safeParse({ ...base, answerText: 'Trevra is...' }).success).toBe(
      false
    );
    expect(
      citationSampleSchema.safeParse({ ...base, citedUrls: ['https://trevra.com/'] }).success
    ).toBe(false);
    expect(citationSampleSchema.safeParse({ ...base, promptRef: 'best crm?' }).success).toBe(false);
  });

  it('prunes samples after 13 months and closes orphaned citation sources', async () => {
    await record(sample());
    await record(sample({ sampleId: 'beseam-0002', answeredAt: '2026-10-03T08:00:00.000Z' }));
    await db
      .prepare(
        "UPDATE ai_citation_samples SET received_at='2025-08-01T00:00:00Z' WHERE watch_id=? AND sample_id=?"
      )
      .run(watch.id, 'beseam-0001');
    await pruneCitationSamples(db, NOW);
    const kept = await db
      .prepare('SELECT sample_id FROM ai_citation_samples WHERE watch_id=?')
      .all<{ sample_id: string }>(watch.id);
    expect(kept.map((row) => row.sample_id)).toEqual(['beseam-0002']);
    const linked = await db
      .prepare('SELECT COUNT(*) AS count FROM capture_sources WHERE id=?')
      .get<{ count: string }>(link.captureSourceId);
    expect(Number(linked?.count)).toBe(1);
    await db.prepare('DELETE FROM brand_watches WHERE id=?').run(watch.id);
    await db
      .prepare("UPDATE capture_sources SET created_at='2026-10-01T00:00:00Z' WHERE id=?")
      .run(link.captureSourceId);
    await pruneCitationSamples(db, NOW);
    const left = await db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM ai_citation_samples WHERE workspace_id=?) AS samples,
                (SELECT COUNT(*) FROM capture_sources WHERE id=?) AS sources`
      )
      .get<{ samples: string; sources: string }>(WORKSPACE, link.captureSourceId);
    expect(Number(left?.samples)).toBe(0);
    expect(Number(left?.sources)).toBe(0);
  });

  it('keeps citation mentions out of sentiment-filtered lists', async () => {
    await record(sample());
    await db
      .prepare(
        `INSERT INTO brand_watch_mentions (
           id, workspace_id, watch_id, platform, external_id, url, title, content,
           sentiment_label, sentiment_score, sentiment_span, sentiment_version, content_hash,
           metadata_json, mention_created_at, first_seen_at, last_seen_at
         ) VALUES ('bwm_scout',?,?,'hackernews','x1','https://news.example/1','t','c',
           'neutral',0,'',1,'h','{}'::jsonb,?,?,?)`
      )
      .run(WORKSPACE, watch.id, NOW.toISOString(), NOW.toISOString(), NOW.toISOString());
    const neutral = await listWatchMentions(db, WORKSPACE, watch.id, { sentiment: 'neutral' });
    expect(neutral.map((m) => m.platform)).toEqual(['hackernews']);
    const cited = await listWatchMentions(db, WORKSPACE, watch.id, { platform: 'ai_answer' });
    expect(cited).toHaveLength(1);
  });

  it('retries the link insert once when the prune closer deletes the reused orphan source', async () => {
    const other = await createWatch(
      db,
      WORKSPACE,
      { name: 'Other', keywords: ['other'], platforms: ['hackernews'], cadence: 'daily' },
      NOW
    );
    const orphan = await createCaptureSource(
      db,
      {
        workspaceId: WORKSPACE,
        actorUserId: USER,
        name: 'orphan',
        kind: 'ai_citations',
        preparationKey: `trevra-citations:${other.id}`,
        preparationHash: createHash('sha256').update(other.id).digest('hex')
      },
      NOW
    );
    let fired = false;
    const racing = new Proxy(db, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== 'prepare') return typeof value === 'function' ? value.bind(target) : value;
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (fired || !sql.includes('INSERT INTO brand_watch_citation_sources')) return stmt;
          return new Proxy(stmt, {
            get(st, key) {
              if (key !== 'get') return Reflect.get(st, key);
              return async (...args: unknown[]) => {
                fired = true;
                await target
                  .prepare('DELETE FROM capture_sources WHERE id=?')
                  .run(orphan.source.id);
                return (st.get as (...a: unknown[]) => Promise<unknown>)(...args);
              };
            }
          });
        };
      }
    }) as Db;
    const result = await connectCitationSource(
      racing,
      { workspaceId: WORKSPACE, actorUserId: USER, watch: other, ownedDomains: ['other.example'] },
      NOW
    );
    expect(fired).toBe(true);
    expect(result.created).toBe(true);
    expect(result.link.captureSourceId).not.toBe(orphan.source.id);
  });

  it('bounds answeredAt to five minutes ahead and 13 months back', async () => {
    const at = (iso: string) => record(sample({ sampleId: `b-${iso}`, answeredAt: iso }));
    await expect(at('2026-10-06T09:04:59.000Z')).resolves.toBeTruthy();
    await expect(at('2026-10-06T09:05:01.000Z')).rejects.toMatchObject({ status: 400 });
    await expect(at('2025-09-06T09:00:01.000Z')).resolves.toBeTruthy();
    await expect(at('2025-09-06T08:59:59.000Z')).rejects.toMatchObject({
      status: 400,
      message: 'answeredAt is older than the retention window'
    });
  });

  it('prunes by calendar months from a 31st-of-month now', async () => {
    const now = new Date('2026-03-31T12:00:00.000Z');
    await record(sample({ sampleId: 'old', answeredAt: '2026-03-30T08:00:00.000Z' }), 'k-old');
    await record(
      sample({ sampleId: 'new', engine: 'gemini', answeredAt: '2026-03-30T08:00:00.000Z' }),
      'k-new'
    );
    const setReceived = (sampleId: string, at: string) =>
      db
        .prepare('UPDATE ai_citation_samples SET received_at=? WHERE watch_id=? AND sample_id=?')
        .run(at, watch.id, sampleId);
    await setReceived('old', '2025-02-27T12:00:00Z'); // 13 months + 1 day before
    await setReceived('new', '2025-03-01T12:00:00Z'); // 13 months - 1 day before
    await pruneCitationSamples(db, now);
    const kept = await db
      .prepare('SELECT sample_id FROM ai_citation_samples WHERE watch_id=?')
      .all<{ sample_id: string }>(watch.id);
    expect(kept.map((row) => row.sample_id)).toEqual(['new']);
  });

  it('serialises concurrent samples so one transition makes one mention', async () => {
    await record(sample({ sampleId: 'c0', brandCited: false, citedUrls: [], position: null }));
    const results = await Promise.all([
      record(sample({ sampleId: 'c1', answeredAt: '2026-10-03T08:00:00.000Z' })),
      record(sample({ sampleId: 'c2', answeredAt: '2026-10-04T08:00:00.000Z' }))
    ]);
    expect(results.filter((r) => r.change === 'gained')).toHaveLength(1);
    expect(
      await listWatchMentions(db, WORKSPACE, watch.id, { platform: 'ai_answer' })
    ).toHaveLength(1);
  });

  it('refuses the same idempotency key with a different payload', async () => {
    await record(sample(), 'shared-key');
    await expect(
      record(sample({ sampleId: 'beseam-other', position: 9 }), 'shared-key')
    ).rejects.toMatchObject({ status: 409 });
  });

  it('makes mentions only on gain and loss across a regained citation', async () => {
    const miss = { brandCited: false, citedUrls: [], position: null };
    const steps = [
      sample({ sampleId: 's1', answeredAt: '2026-10-01T08:00:00.000Z', ...miss }),
      sample({ sampleId: 's2', answeredAt: '2026-10-02T08:00:00.000Z' }),
      sample({ sampleId: 's3', answeredAt: '2026-10-03T08:00:00.000Z', ...miss }),
      sample({ sampleId: 's4', answeredAt: '2026-10-04T08:00:00.000Z', ...miss }),
      sample({ sampleId: 's5', answeredAt: '2026-10-05T08:00:00.000Z' })
    ];
    const outcomes: string[] = [];
    for (const step of steps) outcomes.push((await record(step)).change);
    expect(outcomes).toEqual(['absent', 'gained', 'lost', 'absent', 'gained']);
    expect(
      await listWatchMentions(db, WORKSPACE, watch.id, { platform: 'ai_answer' })
    ).toHaveLength(3);
  });

  it('handles IDN and userinfo cited URLs without storing userinfo or foreign hosts', async () => {
    const attempt = (url: string, n: string) =>
      record(sample({ sampleId: `u-${n}`, citedUrls: [url] })).catch((caught: unknown) => caught);
    const foreign = await attempt('https://bücher.example/', 'idn');
    expect(foreign).toBeInstanceOf(LeadCaptureError);
    const reversed = await attempt('https://trevra.com@evil.com/', 'rev');
    expect((reversed as LeadCaptureError).status).toBe(400);
    const userinfo = await attempt('https://evil.com@trevra.com/', 'ui');
    expect(userinfo).toBeInstanceOf(LeadCaptureError);
    const rows = await db
      .prepare(
        "SELECT metadata_json::text AS m FROM brand_watch_mentions WHERE platform='ai_answer'"
      )
      .all<{ m: string }>();
    for (const row of rows) expect(row.m).not.toContain('@');
  });
});
