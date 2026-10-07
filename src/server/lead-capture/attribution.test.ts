import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { createOpportunity, listOpportunities } from '../opportunities.js';
import { createCaptureSource } from './sources.js';
import { acceptInboundSubmission } from './submissions.js';
import { inboundSubmissionSchema, type CaptureSourceRecord } from './types.js';
import { inboundAttributionSummary } from './attribution.js';

const WS = 'ws_inbound_attribution';
const OTHER = 'ws_inbound_attribution_other';
const USER = 'usr_inbound_attribution';
const OTHER_USER = 'usr_inbound_attribution_other';
const NOW = new Date('2026-10-06T09:00:00.000Z');
let db: Db;
let source: CaptureSourceRecord;
let otherSource: CaptureSourceRecord;

async function submit(
  from: CaptureSourceRecord,
  key: string,
  kind: string,
  email: string,
  attribution: Record<string, string>,
  receivedAt = NOW
) {
  return acceptInboundSubmission(db, {
    source: from,
    idempotencyKey: key,
    body: inboundSubmissionSchema.parse({ kind, person: { email }, attribution }),
    payloadHash: `hash-${key}`,
    receivedAt
  });
}

async function clear(): Promise<void> {
  for (const workspaceId of [WS, OTHER]) {
    await db.prepare('DELETE FROM inbound_submissions WHERE workspace_id=?').run(workspaceId);
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  }
}

beforeAll(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
});

beforeEach(async () => {
  await clear();
  for (const [workspaceId, userId] of [
    [WS, USER],
    [OTHER, OTHER_USER]
  ]) {
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(workspaceId, workspaceId, NOW.toISOString());
    await db
      .prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)')
      .run(userId, workspaceId, `${userId}@attr.test`, userId, NOW.toISOString());
  }
  source = (
    await createCaptureSource(db, {
      workspaceId: WS,
      actorUserId: USER,
      name: 'Site',
      kind: 'website'
    })
  ).source;
  otherSource = (
    await createCaptureSource(db, {
      workspaceId: OTHER,
      actorUserId: OTHER_USER,
      name: 'Site',
      kind: 'website'
    })
  ).source;
});

afterAll(async () => {
  await clear();
  await db?.close();
});

describe('self-reported attribution', () => {
  it('normalises heard_about to the bounded list and drops free text', () => {
    const parse = (heard: unknown) =>
      inboundSubmissionSchema.parse({
        kind: 'demo_request',
        person: { email: 'a@b.test' },
        attribution: { heard_about: heard }
      }).attribution?.heard_about;
    expect(parse('Podcast')).toBe('podcast');
    expect(parse(' AI assistant ')).toBe('ai_assistant');
    expect(parse('ai-assistant')).toBe('ai_assistant');
    expect(parse('my cousin told me')).toBe('other');
    expect(() => parse('x'.repeat(121))).toThrow();
    expect(() =>
      inboundSubmissionSchema.parse({
        kind: 'demo_request',
        person: { email: 'a@b.test' },
        attribution: { referrer_note: 'x' }
      })
    ).toThrow();
  });

  it('counts 90 days by utm_source and heard_about, without milestones or other workspaces', async () => {
    const ada = await submit(source, 'attr-ada-001', 'demo_request', 'ada@attr.test', {
      utm_source: 'Newsletter',
      heard_about: 'Podcast'
    });
    await submit(source, 'attr-ada-002', 'pricing_request', 'ada@attr.test', {
      utm_source: 'newsletter'
    });
    await submit(source, 'attr-bob-001', 'contact_message', 'bob@attr.test', {
      utm_source: 'newsletter'
    });
    await submit(source, 'attr-cy-001', 'contact_message', 'cy@attr.test', {
      heard_about: 'github'
    });
    await submit(source, 'attr-dee-001', 'signed_up', 'dee@attr.test', {
      utm_source: 'newsletter',
      heard_about: 'podcast'
    });
    await submit(
      source,
      'attr-old-001',
      'demo_request',
      'old@attr.test',
      { utm_source: 'newsletter' },
      new Date(NOW.getTime() - 100 * 86_400_000)
    );
    await submit(otherSource, 'attr-other-001', 'demo_request', 'ada@attr.test', {
      utm_source: 'newsletter'
    });
    await createOpportunity(db, { workspaceId: WS, personId: ada.contactId, title: 'Ada' }, NOW);

    const summary = await inboundAttributionSummary(db, WS, NOW);
    expect(summary.days).toBe(90);
    expect(summary.byUtmSource).toEqual([
      { value: 'newsletter', submissions: 3, people: 2, peopleWithOpportunity: 1 }
    ]);
    expect(summary.byHeardAbout).toEqual([
      { value: 'github', submissions: 1, people: 1, peopleWithOpportunity: 0 },
      { value: 'podcast', submissions: 1, people: 1, peopleWithOpportunity: 1 }
    ]);
  });

  it('shows first-touch attribution on the Opportunity', async () => {
    const first = await submit(
      source,
      'attr-src-001',
      'demo_request',
      'eve@attr.test',
      { utm_source: 'linkedin', heard_about: 'Social' },
      new Date(NOW.getTime() - 2 * 86_400_000)
    );
    await submit(source, 'attr-src-002', 'pricing_request', 'eve@attr.test', {
      utm_source: 'google'
    });
    const opportunity = await createOpportunity(
      db,
      { workspaceId: WS, personId: first.contactId, title: 'Eve' },
      NOW
    );
    expect(opportunity).toMatchObject({ sourceUtmSource: 'linkedin', sourceHeardAbout: 'social' });
    const [listed] = await listOpportunities(db, WS);
    expect(listed).toMatchObject({ sourceUtmSource: 'linkedin', sourceHeardAbout: 'social' });
  });

  it('ignores an earlier milestone submission when choosing the first touch', async () => {
    const milestone = await submit(
      source,
      'attr-ms-001',
      'signed_up',
      'fay@attr.test',
      { utm_source: 'x', heard_about: 'Podcast' },
      new Date(NOW.getTime() - 3 * 86_400_000)
    );
    await submit(
      source,
      'attr-ms-002',
      'demo_request',
      'fay@attr.test',
      { utm_source: 'y' },
      new Date(NOW.getTime() - 1 * 86_400_000)
    );
    const opportunity = await createOpportunity(
      db,
      { workspaceId: WS, personId: milestone.contactId, title: 'Fay' },
      NOW
    );
    expect(opportunity).toMatchObject({ sourceUtmSource: 'y', sourceHeardAbout: null });
  });
});
