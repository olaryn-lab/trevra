import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { id, openDatabase, type Db } from '../db.js';
import { UNCITABLE_SIGNAL_KINDS_SQL } from './types.js';
import { recordSignals } from './sweep.js';
import { buildDemandCandidates } from '../demand/candidates.js';
import { httpObservationProvider } from '../observations/providers/http.js';

const WS = 'ws_uncitable_signals';
const NOW = new Date('2026-10-06T09:00:00.000Z');
const CITING_FILES = [
  'src/server/content/opportunity-builder.ts',
  'src/server/content/pulse.ts',
  'src/server/content/index.ts',
  'src/server/demand/candidates.ts'
];

describe('uncitable signal kinds', () => {
  it('lists the baseline and every first-party kind', () => {
    expect(UNCITABLE_SIGNAL_KINDS_SQL).toBe(
      "('first-capture','product-signed-up','product-activated','product-integration-connected','product-usage-threshold','customer-paid','customer-upgraded','customer-cancelled')"
    );
  });

  it('is the exclusion every evidence query uses', () => {
    for (const file of CITING_FILES) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8');
      expect(source, file).not.toContain("kind<>'first-capture'");
      expect(source, file).toContain('NOT IN ${UNCITABLE_SIGNAL_KINDS_SQL}');
    }
  });

  it('refuses a first-party kind from an external observation provider', async () => {
    const provider = httpObservationProvider({
      key: 'commerce-observer',
      name: 'Commerce observation plane',
      endpoint: 'https://observer.example/observe',
      tokenEnv: null,
      docsUrl: 'https://observer.example/docs',
      surfaces: ['site']
    });
    const result = await provider.observe('shop.example', {
      credentials: { get: () => undefined },
      now: NOW,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            observations: [
              {
                kind: 'customer-paid',
                detail: 'Forged payment.',
                previous: null,
                current: 'paid',
                evidenceUrl: 'https://shop.example/',
                observedAt: '2026-10-06T08:00:00.000Z'
              }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    });
    expect(result.observations).toEqual([]);
    expect(
      result.warnings.some((warning) => warning.includes("unknown signal kind 'customer-paid'"))
    ).toBe(true);
  });
});

describe('demand evidence', () => {
  let db: Db;
  let milestoneAccountId = '';
  let controlAccountId = '';

  async function seedHotDormantAccount(
    label: string,
    signal: { kind: string; evidenceUrl: string }
  ): Promise<string> {
    const personId = id('con');
    const accountId = id('acc');
    const at = NOW.toISOString();
    const old = new Date(NOW.getTime() - 20 * 86_400_000).toISOString();
    await db
      .prepare(
        'INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
      )
      .run(
        personId,
        WS,
        `${label} Person`,
        `${label}@uncitable.test`,
        `${label}@uncitable.test`,
        at,
        at
      );
    await db
      .prepare(
        "INSERT INTO accounts (id,workspace_id,name,domain,source,status,created_at,updated_at) VALUES (?,?,?,?, 'manual','active',?,?)"
      )
      .run(accountId, WS, `${label} Co`, `${label}.uncitable.test`, at, at);
    await db
      .prepare(
        `INSERT INTO opportunities (id,workspace_id,person_id,account_id,title,stage,owner_type,created_at,updated_at)
         VALUES (?,?,?,?,?,'qualified','system',?,?)`
      )
      .run(id('opp'), WS, personId, accountId, `${label} pilot`, old, old);
    await db
      .prepare(
        `INSERT INTO account_scores (workspace_id,account_id,score,tier,distinct_kinds,newest_signal_at,computed_at)
         VALUES (?,?,90,'hot',2,?,?)`
      )
      .run(WS, accountId, new Date(NOW.getTime() - 3_600_000).toISOString(), at);
    await recordSignals(
      db,
      WS,
      accountId,
      [
        {
          kind: signal.kind,
          detail: `${label} moved.`,
          previous: null,
          current: `${label}:now`,
          evidenceUrl: signal.evidenceUrl,
          observedAt: new Date(NOW.getTime() - 3_600_000)
        }
      ],
      NOW
    );
    return accountId;
  }

  beforeEach(async () => {
    db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(WS);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(WS, WS, NOW.toISOString());
    milestoneAccountId = await seedHotDormantAccount('milestone', {
      kind: 'product-activated',
      evidenceUrl: '/outreach/inbound?milestone=pm_uncitable'
    });
    controlAccountId = await seedHotDormantAccount('control', {
      kind: 'pricing-changed',
      evidenceUrl: 'https://control.uncitable.test/pricing'
    });
  });

  afterEach(async () => {
    await db?.prepare('DELETE FROM workspaces WHERE id=?').run(WS);
    await db?.close();
  });

  it('never builds a demand recommendation from first-party milestones alone', async () => {
    const candidates = await buildDemandCandidates(db, WS, NOW);
    // Positive control: the same setup with a public signal does produce one.
    expect(candidates.some((candidate) => candidate.accountId === controlAccountId)).toBe(true);
    expect(candidates.filter((candidate) => candidate.accountId === milestoneAccountId)).toEqual(
      []
    );
  });
});
