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
});
