/**
 * TRV-029 acceptance: inbound and imported People reach campaigns, and
 * workspace suppression / Never Contact authority holds at the planning
 * boundary.
 *
 * Real PostgreSQL, the real `createApp` routes wherever an HTTP surface exists,
 * and the real runner. No live provider is contacted: the email leg uses a
 * mailbox binding that does not exist, so a planned email row is held rather
 * than sent.
 *
 * Proven here: signed capture, account import with People, Stripe payer
 * convergence, the MANUAL capture -> lead list -> campaign bridge (the Inbound
 * screen's one-row CSV import), auto-enrol rules (a capture source or a lead
 * list enrolling new leads into a chosen campaign through the same admission
 * path), account-import People reaching a lead list and its campaigns, and
 * email / linked-Person suppressions holding at the send-time LinkedIn guard.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import Stripe from 'stripe';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { openDatabase, type Db } from '../db.js';
import { createProviderWebhookEndpoint } from '../provider-webhooks/index.js';
import { evaluateLinkedInSafety } from '../linkedin/guard.js';
import { runManagedCampaigns } from '../linkedin/runner.js';
import { upsertSeat } from '../linkedin/seats.js';
import { resolveContact } from './people.js';
import { createCaptureSource } from './sources.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const previousSecretsKey = process.env.TREVRA_SECRETS_KEY;

let db: Db;
let app: Express;
let sequence = 0;

interface Ws {
  id: string;
  userId: string;
  token: string;
  source: { id: string; secret: string };
  webinar: { id: string; secret: string };
}

let A: Ws;
let B: Ws;

/** The exact columns and mapping `InboundPeople.tsx` sends through the CSV reader. */
const LEAD_HEADERS = ['firstName', 'lastName', 'company', 'email', 'phone'] as const;
const LEAD_MAPPING = {
  firstName: 'firstName',
  lastName: 'lastName',
  company: 'company',
  email: 'email',
  phone: 'phone'
};

const inviteStep = (
  delay: { amount: number; unit: 'hours' | 'days' } = {
    amount: 0,
    unit: 'hours'
  }
) => ({
  id: 'invite',
  action: 'connection_request',
  delayBefore: delay,
  config: { message: 'Hello {{first_name}} at {{company}}' }
});
const emailStep = {
  id: 'email',
  action: 'email',
  delayBefore: { amount: 0, unit: 'hours' },
  config: {
    subject: 'Hello {{company}}',
    variants: [{ id: 'a', body: 'Hello {{first_name}} at {{company}}', weight: 100 }],
    tracking: 'off',
    threaded: false
  }
};

function later(hours: number): Date {
  return new Date(Date.now() + hours * HOUR);
}

function as(ws: Ws) {
  const cookie = `trevra_session=${ws.token}`;
  return {
    get: (url: string) => request(app).get(url).set('Cookie', cookie),
    post: (url: string) => request(app).post(url).set('Cookie', cookie),
    patch: (url: string) => request(app).patch(url).set('Cookie', cookie),
    delete: (url: string) => request(app).delete(url).set('Cookie', cookie)
  };
}

async function workspace(label: string): Promise<Ws> {
  sequence += 1;
  const id = `ws_trv029_${label}_${process.pid}_${sequence}_${randomBytes(3).toString('hex')}`;
  const userId = `usr_${id}`;
  await db.prepare('INSERT INTO workspaces(id,name,created_at) VALUES (?,?,now())').run(id, id);
  await db
    .prepare('INSERT INTO users(id,workspace_id,email,name,created_at) VALUES (?,?,?,?,now())')
    .run(userId, id, `${userId}@trevra.test`, userId);
  const token = randomBytes(32).toString('hex');
  await db
    .prepare(
      "INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES (?,?,now()+interval '1 day',now())"
    )
    .run(createHash('sha256').update(token).digest('hex'), userId);
  const website = await createCaptureSource(db, {
    workspaceId: id,
    actorUserId: userId,
    name: 'Website',
    kind: 'website'
  });
  const webinar = await createCaptureSource(db, {
    workspaceId: id,
    actorUserId: userId,
    name: 'Webinar',
    kind: 'website'
  });
  await upsertSeat(
    db,
    id,
    {
      label: 'Owner',
      timezone: 'UTC',
      workingDays: [0, 1, 2, 3, 4, 5, 6],
      workStartMinute: 0,
      workEndMinute: 1440,
      // An established account: enrolment, not the cold-account ramp (one
      // action on day one), is what these cases exercise.
      warmupOverride: true
    },
    new Date()
  );
  return {
    id,
    userId,
    token,
    source: { id: website.source.id, secret: website.secret },
    webinar: { id: webinar.source.id, secret: webinar.secret }
  };
}

function capture(
  source: { id: string; secret: string },
  key: string,
  body: Record<string, unknown>,
  signWith = source.secret
) {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', signWith)
    .update(Buffer.concat([Buffer.from(`${timestamp}.${key}.`), Buffer.from(raw)]))
    .digest('hex');
  return {
    raw,
    response: request(app)
      .post('/api/intake/v1/submissions')
      .set('Content-Type', 'application/json')
      .set('X-Trevra-Source', source.id)
      .set('X-Trevra-Timestamp', timestamp)
      .set('X-Trevra-Idempotency-Key', key)
      .set('X-Trevra-Signature', `sha256=${signature}`)
      .send(raw)
  };
}

interface Person {
  first: string;
  last: string;
  company: string;
  email: string;
  slug: string;
}

function person(label: string): Person {
  sequence += 1;
  const slug = `trv029-${label}-${sequence}-${randomBytes(2).toString('hex')}`;
  return {
    first: label.charAt(0).toUpperCase() + label.slice(1),
    last: 'Inbound',
    company: 'Acme Inbound',
    email: `${slug}@acme-inbound.test`,
    slug
  };
}

const profileOf = (p: Person) => `https://www.linkedin.com/in/${p.slug}`;

/** Signed capture of one Person; returns the canonical contact id. */
async function captured(ws: Ws, p: Person): Promise<string> {
  const { response } = capture(ws.source, `cap-${p.slug}`, {
    kind: 'demo_request',
    person: { name: `${p.first} ${p.last}`, email: p.email },
    company: { domain: 'acme-inbound.example', name: p.company }
  });
  const accepted = await response.expect(202);
  return accepted.body.personId as string;
}

async function leadList(ws: Ws, name: string): Promise<string> {
  const created = await as(ws)
    .post('/api/linkedin/manager/lead-lists')
    .send({ name, sourceKind: 'csv' })
    .expect(201);
  return created.body.list.id as string;
}

/**
 * The Inbound screen's "Add to lead list": one row through the CSV reader with
 * its exact headers and mapping. `withProfile` adds the LinkedIn profile column
 * that screen does not send today; `withEmail` false leaves the email cell empty.
 */
async function addToLeadList(
  ws: Ws,
  listId: string,
  p: Person,
  withProfile = true,
  withEmail = true
) {
  const headers: string[] = [...LEAD_HEADERS];
  const values = [p.first, p.last, p.company, withEmail ? p.email : '', ''];
  const mapping: Record<string, string> = { ...LEAD_MAPPING };
  if (withProfile) {
    headers.push('profileUrl');
    values.push(profileOf(p));
    mapping.profileUrl = 'profileUrl';
  }
  const csv = `${headers.join(',')}\n${values.join(',')}\n`;
  const result = await as(ws)
    .post(`/api/linkedin/manager/lead-lists/${listId}/import`)
    .field('mapping', JSON.stringify(mapping))
    .attach('file', Buffer.from(csv), {
      filename: `inbound-${p.slug}.csv`,
      contentType: 'text/csv'
    })
    .expect(201);
  return result.body as { inserted: number; duplicates: number; rejected: unknown[] };
}

async function workflow(ws: Ws, steps: unknown[]): Promise<string> {
  sequence += 1;
  const created = await as(ws)
    .post('/api/linkedin/manager/workflows')
    .send({ name: `TRV-029 workflow ${sequence}`, steps })
    .expect(201);
  return created.body.workflow.id as string;
}

async function campaign(
  ws: Ws,
  listId: string,
  steps: unknown[],
  extra: Record<string, unknown> = {}
): Promise<{ id: string; enrolled: number; excluded: number }> {
  sequence += 1;
  const workflowId = await workflow(ws, steps);
  const created = await as(ws)
    .post('/api/linkedin/manager/campaigns')
    .send({
      name: `TRV-029 campaign ${sequence}`,
      leadListId: listId,
      workflowId,
      senderKeys: ['owner'],
      ...extra
    })
    .expect(201);
  return {
    id: created.body.campaign.id as string,
    enrolled: created.body.enrolled as number,
    excluded: created.body.excluded as number
  };
}

async function start(ws: Ws, campaignId: string): Promise<void> {
  await as(ws).post(`/api/linkedin/manager/campaigns/${campaignId}/start`).send({}).expect(200);
}

async function suppressNotALead(ws: Ws, contactId: string, email: string | null) {
  // The exact body InboundPeople.tsx sends for "Mark not a lead".
  const created = await as(ws)
    .post('/api/suppressions')
    .send({ channel: 'all', personId: contactId, email, reason: 'Marked not a lead from Inbound' })
    .expect(201);
  return created.body.suppression as { id: string; personId: string | null };
}

async function lead(ws: Ws, email: string) {
  const row = await db
    .prepare(
      'SELECT id,person_id,profile_url FROM linkedin_lead_contacts WHERE workspace_id=? AND LOWER(email)=LOWER(?)'
    )
    .get<{ id: string; person_id: string | null; profile_url: string | null }>(ws.id, email);
  if (!row) throw new Error(`lead ${email} not found`);
  return row;
}

interface MemberRow {
  id: string;
  status: string;
  exclusion_reason: string | null;
  admitted_at: string | null;
}

async function member(ws: Ws, campaignId: string, email: string): Promise<MemberRow> {
  const row = await db
    .prepare(
      `SELECT m.id,m.status,m.exclusion_reason,m.admitted_at::text AS admitted_at
       FROM linkedin_campaign_members m
       JOIN linkedin_lead_contacts c ON c.workspace_id=m.workspace_id AND c.id=m.contact_id
       WHERE m.workspace_id=? AND m.campaign_id=? AND LOWER(c.email)=LOWER(?)`
    )
    .get<MemberRow>(ws.id, campaignId, email);
  if (!row) throw new Error(`member ${email} not found`);
  return row;
}

interface ActionRow {
  id: string;
  kind: string;
  status: string;
  source: string;
  campaign_member_id: string | null;
  target_ref: string | null;
}

async function actionsFor(ws: Ws, memberId: string): Promise<ActionRow[]> {
  return db
    .prepare(
      `SELECT id,kind,status,source,campaign_member_id,target_ref FROM linkedin_actions
       WHERE workspace_id=? AND campaign_member_id=? ORDER BY created_at,id`
    )
    .all<ActionRow>(ws.id, memberId);
}

async function actionsTargeting(ws: Ws, p: Person): Promise<ActionRow[]> {
  return db
    .prepare(
      `SELECT id,kind,status,source,campaign_member_id,target_ref FROM linkedin_actions
       WHERE workspace_id=? AND LOWER(target_ref) LIKE ? ORDER BY created_at,id`
    )
    .all<ActionRow>(ws.id, `%/in/${p.slug.toLowerCase()}%`);
}

async function count(sql: string, ...params: unknown[]): Promise<number> {
  const row = await db.prepare(sql).get<{ n: number }>(...params);
  return Number(row?.n ?? 0);
}

/** The send-time guard's suppression check for one LinkedIn invite at `p`'s profile. */
async function sendTimeSuppression(ws: Ws, p: Person) {
  const now = new Date();
  const verdict = await evaluateLinkedInSafety(
    db,
    { workspaceId: ws.id, kind: 'invite', targetRef: profileOf(p), plannedFor: now.toISOString() },
    now
  );
  const check = verdict.checks.find((entry) => entry.check === 'suppression');
  if (!check) throw new Error('suppression check missing');
  return check;
}

async function leadByProfile(ws: Ws, p: Person) {
  const row = await db
    .prepare(
      "SELECT id,person_id,email FROM linkedin_lead_contacts WHERE workspace_id=? AND LOWER(RTRIM(profile_url,'/'))=LOWER(?)"
    )
    .get<{ id: string; person_id: string | null; email: string | null }>(ws.id, profileOf(p));
  if (!row) throw new Error(`lead ${p.slug} not found`);
  return row;
}

async function memberByContact(ws: Ws, campaignId: string, contactId: string): Promise<MemberRow> {
  const row = await db
    .prepare(
      `SELECT id,status,exclusion_reason,admitted_at::text AS admitted_at FROM linkedin_campaign_members
       WHERE workspace_id=? AND campaign_id=? AND contact_id=?`
    )
    .get<MemberRow>(ws.id, campaignId, contactId);
  if (!row) throw new Error(`member ${contactId} not found`);
  return row;
}

/** Campaign members whose lead carries `email`, whatever their status. */
async function membersWithEmail(ws: Ws, campaignId: string, email: string): Promise<number> {
  return count(
    `SELECT COUNT(*)::int AS n FROM linkedin_campaign_members m
     JOIN linkedin_lead_contacts c ON c.workspace_id=m.workspace_id AND c.id=m.contact_id
     WHERE m.workspace_id=? AND m.campaign_id=? AND LOWER(c.email)=LOWER(?)`,
    ws.id,
    campaignId,
    email
  );
}

/** A Person Trevra already knows with a LinkedIn profile (an earlier list import or enrichment). */
async function knownWithProfile(ws: Ws, p: Person): Promise<string> {
  const resolved = await resolveContact(db, ws.id, {
    name: `${p.first} ${p.last}`,
    email: p.email,
    linkedinUrl: profileOf(p)
  });
  return resolved.contact.id;
}

function captureBody(p: Person) {
  return {
    kind: 'demo_request',
    person: { name: `${p.first} ${p.last}`, email: p.email },
    company: { domain: 'acme-inbound.example', name: p.company }
  };
}

/** A started invite campaign over a fresh list holding one control lead. */
async function runningCampaign(ws: Ws, name: string): Promise<{ id: string; listId: string }> {
  const listId = await leadList(ws, name);
  await addToLeadList(ws, listId, person('control'));
  const made = await campaign(ws, listId, [inviteStep()]);
  await start(ws, made.id);
  return { id: made.id, listId };
}

interface AutoRule {
  id: string;
  campaignId: string;
  sourceKind: string;
  sourceId: string;
  status: string;
}

async function autoRule(
  ws: Ws,
  campaignId: string,
  sourceKind: 'capture_source' | 'lead_list',
  sourceId: string
): Promise<AutoRule> {
  const created = await as(ws)
    .post(`/api/linkedin/manager/campaigns/${campaignId}/auto-enrol-rules`)
    .send({ sourceKind, sourceId });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.rule as AutoRule;
}

interface AutoEnrolEvent {
  stream_type: string;
  stream_id: string;
  actor_type: string;
  actor_id: string;
  correlation_id: string | null;
  payload_json: Record<string, unknown>;
}

async function autoEnrolEvents(ws: Ws, campaignId: string): Promise<AutoEnrolEvent[]> {
  return db
    .prepare(
      `SELECT stream_type,stream_id,actor_type,actor_id,correlation_id,payload_json FROM domain_events
       WHERE workspace_id=? AND event_type='linkedin_campaign.member_auto_enrolled'
         AND payload_json->>'campaignId'=? ORDER BY position`
    )
    .all<AutoEnrolEvent>(ws.id, campaignId);
}

beforeAll(async () => {
  process.env.TREVRA_SECRETS_KEY = randomBytes(32).toString('base64');
  await migrateAuthDatabase();
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
});

beforeEach(async () => {
  A = await workspace('a');
  B = await workspace('b');
});

afterAll(async () => {
  if (previousSecretsKey === undefined) delete process.env.TREVRA_SECRETS_KEY;
  else process.env.TREVRA_SECRETS_KEY = previousSecretsKey;
  await db?.close();
  await closeAuthDatabase();
});

describe('TRV-029 capture sources land as canonical People with provenance', () => {
  it('signed capture creates one contact with source provenance, retries are duplicates, and a second source converges on the same Person', async () => {
    const p = person('ada');
    const body = {
      kind: 'demo_request',
      person: { name: 'Ada Inbound', email: p.email.toUpperCase(), role: 'CTO' },
      company: { domain: 'acme-inbound.example', name: 'Acme Inbound' },
      attribution: { utm_source: 'newsletter', utm_campaign: 'fall' }
    };
    const first = capture(A.source, 'web-key-001', body);
    const accepted = await first.response;
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
    const contactId = accepted.body.personId as string;
    expect(contactId).toMatch(/^con_/);
    expect(accepted.body.duplicate).toBe(false);

    const contact = await db
      .prepare('SELECT id,email_normalized FROM contacts WHERE workspace_id=? AND id=?')
      .get<{ id: string; email_normalized: string }>(A.id, contactId);
    expect(contact?.email_normalized).toBe(p.email.toLowerCase());

    const submission = await db
      .prepare(
        `SELECT capture_source_id,contact_id,payload_hash,attribution_json->>'utm_source' AS utm_source,account_id
         FROM inbound_submissions WHERE workspace_id=? AND idempotency_key='web-key-001'`
      )
      .get<{
        capture_source_id: string;
        contact_id: string;
        payload_hash: string;
        utm_source: string;
        account_id: string | null;
      }>(A.id);
    expect(submission).toMatchObject({
      capture_source_id: A.source.id,
      contact_id: contactId,
      payload_hash: createHash('sha256').update(first.raw).digest('hex'),
      utm_source: 'newsletter'
    });
    expect(submission?.account_id).toMatch(/^acc/);

    const created = await db
      .prepare(
        `SELECT actor_type,actor_id FROM domain_events
         WHERE workspace_id=? AND stream_type='contact' AND stream_id=? AND event_type='contact.created'`
      )
      .all<{ actor_type: string; actor_id: string }>(A.id, contactId);
    expect(created).toEqual([{ actor_type: 'system', actor_id: A.source.id }]);

    const link = await db
      .prepare(
        'SELECT account_id,source,source_detail FROM account_contacts WHERE workspace_id=? AND contact_id=?'
      )
      .all<{ account_id: string; source: string; source_detail: string }>(A.id, contactId);
    expect(link).toEqual([
      {
        account_id: submission?.account_id,
        source: 'capture',
        source_detail: `capture:${A.source.id}`
      }
    ]);

    // A provider retry with the same key and body is a duplicate of the same Person.
    const retry = await capture(A.source, 'web-key-001', body).response.expect(200);
    expect(retry.body).toMatchObject({ duplicate: true, personId: contactId });
    // The same key with a different payload is refused, never a second Person.
    await capture(A.source, 'web-key-001', { ...body, message: 'changed' }).response.expect(409);
    expect(
      await count(
        "SELECT COUNT(*)::int AS n FROM inbound_submissions WHERE workspace_id=? AND idempotency_key='web-key-001'",
        A.id
      )
    ).toBe(1);

    // Another capture source, another key, same email: one canonical Person.
    const webinar = await capture(A.webinar, 'webinar-001', {
      kind: 'webinar_registration',
      person: { name: 'Ada I.', email: p.email }
    }).response.expect(202);
    expect(webinar.body.personId).toBe(contactId);
    const matched = await db
      .prepare(
        `SELECT actor_id FROM domain_events
         WHERE workspace_id=? AND stream_type='contact' AND stream_id=? AND event_type='contact.matched'`
      )
      .all<{ actor_id: string }>(A.id, contactId);
    expect(matched).toEqual([{ actor_id: A.webinar.id }]);
    expect(
      await count(
        'SELECT COUNT(*)::int AS n FROM contacts WHERE workspace_id=? AND email_normalized=?',
        A.id,
        p.email.toLowerCase()
      )
    ).toBe(1);
  });

  it('refuses a submission whose identities point at two different People and writes nothing', async () => {
    const one = person('one');
    const two = person('two');
    await capture(A.source, 'conflict-a', {
      kind: 'demo_request',
      person: { email: one.email }
    }).response.expect(202);
    await capture(A.source, 'conflict-b', {
      kind: 'demo_request',
      person: { email: two.email, phone: '+41441230001' }
    }).response.expect(202);
    const contactsBefore = await count(
      'SELECT COUNT(*)::int AS n FROM contacts WHERE workspace_id=?',
      A.id
    );
    const eventsBefore = await count(
      'SELECT COUNT(*)::int AS n FROM domain_events WHERE workspace_id=?',
      A.id
    );

    await capture(A.source, 'conflict-c', {
      kind: 'demo_request',
      person: { email: one.email, phone: '+41441230001' }
    }).response.expect(409);

    expect(await count('SELECT COUNT(*)::int AS n FROM contacts WHERE workspace_id=?', A.id)).toBe(
      contactsBefore
    );
    expect(
      await count('SELECT COUNT(*)::int AS n FROM domain_events WHERE workspace_id=?', A.id)
    ).toBe(eventsBefore);
    expect(
      await count(
        "SELECT COUNT(*)::int AS n FROM inbound_submissions WHERE workspace_id=? AND idempotency_key='conflict-c'",
        A.id
      )
    ).toBe(0);
  });

  it('account import with People creates contacts linked as source import with the human actor, and a re-import dedupes', async () => {
    const captureFirst = person('shared');
    const capturedId = await captured(A, captureFirst);
    const body = {
      text: 'import-co.example',
      people: [
        {
          accountDomain: 'import-co.example',
          name: 'Imp Person',
          email: 'imp.person@import-co.example',
          role: 'CTO',
          sourcePath: 'trv029.csv'
        },
        // Same email as an earlier capture: the import matches, never duplicates.
        { accountDomain: 'import-co.example', name: 'Shared', email: captureFirst.email }
      ]
    };
    const first = await as(A).post('/api/accounts/import').send(body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.people).toEqual({ created: 1, matched: 1, linked: 2, skipped: 0 });

    const imported = await db
      .prepare('SELECT id FROM contacts WHERE workspace_id=? AND email_normalized=?')
      .get<{ id: string }>(A.id, 'imp.person@import-co.example');
    expect(imported?.id).toMatch(/^con_/);
    const link = await db
      .prepare(
        `SELECT ac.source,ac.source_detail,a.domain FROM account_contacts ac
         JOIN accounts a ON a.workspace_id=ac.workspace_id AND a.id=ac.account_id
         WHERE ac.workspace_id=? AND ac.contact_id=?`
      )
      .all<{ source: string; source_detail: string; domain: string }>(A.id, imported!.id);
    expect(link).toEqual([
      { source: 'import', source_detail: 'trv029.csv', domain: 'import-co.example' }
    ]);
    const created = await db
      .prepare(
        `SELECT actor_type,actor_id,payload_json->>'source' AS source FROM domain_events
         WHERE workspace_id=? AND stream_type='contact' AND stream_id=? AND event_type='contact.created'`
      )
      .all<{ actor_type: string; actor_id: string; source: string }>(A.id, imported!.id);
    expect(created).toEqual([
      { actor_type: 'human', actor_id: A.userId, source: 'account-import' }
    ]);
    expect(
      await count(
        'SELECT COUNT(*)::int AS n FROM contacts WHERE workspace_id=? AND email_normalized=?',
        A.id,
        captureFirst.email.toLowerCase()
      )
    ).toBe(1);
    expect(
      await count(
        "SELECT COUNT(*)::int AS n FROM account_contacts WHERE workspace_id=? AND contact_id=? AND source='import'",
        A.id,
        capturedId
      )
    ).toBe(1);

    const again = await as(A).post('/api/accounts/import').send(body).expect(200);
    expect(again.body.people).toEqual({ created: 0, matched: 2, linked: 0, skipped: 0 });
    expect(
      await count(
        'SELECT COUNT(*)::int AS n FROM contacts WHERE workspace_id=? AND email_normalized=?',
        A.id,
        'imp.person@import-co.example'
      )
    ).toBe(1);
    expect(
      await count(
        'SELECT COUNT(*)::int AS n FROM account_contacts WHERE workspace_id=? AND contact_id=?',
        A.id,
        imported!.id
      )
    ).toBe(1);
  });

  it('a Stripe payer converges on the Person an earlier capture created', async () => {
    const p = person('payer');
    const contactId = await captured(A, p);
    const secret = `whsec_${randomBytes(24).toString('hex')}`;
    const endpoint = await createProviderWebhookEndpoint(db, {
      workspaceId: A.id,
      actorUserId: A.userId,
      provider: 'stripe',
      signingSecret: secret
    });
    const payload = JSON.stringify({
      object: 'event',
      api_version: '2026-09-30',
      id: `evt_${p.slug}`,
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000) - 5,
      livemode: true,
      data: {
        object: {
          id: `cs_${p.slug}`,
          object: 'checkout.session',
          customer: `cus_${p.slug}`,
          customer_details: { email: p.email, name: 'Payer Inbound' },
          mode: 'payment',
          payment_status: 'paid',
          amount_total: 5000
        },
        previous_attributes: null
      }
    });
    const delivered = await request(app)
      .post(`/api/hooks/v1/stripe/${endpoint.id}`)
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', Stripe.webhooks.generateTestHeaderString({ payload, secret }))
      .send(payload)
      .expect(200);
    expect(delivered.body).toEqual({ received: true, handled: true });
    expect(
      await count(
        "SELECT COUNT(*)::int AS n FROM product_milestones WHERE workspace_id=? AND kind='paid' AND contact_id=?",
        A.id,
        contactId
      )
    ).toBe(1);
    expect(
      await count(
        'SELECT COUNT(*)::int AS n FROM contacts WHERE workspace_id=? AND email_normalized=?',
        A.id,
        p.email.toLowerCase()
      )
    ).toBe(1);
  });
});

describe('TRV-029 captured leads enrol into campaigns through the existing manual bridge', () => {
  it('a captured Person added to a lead list is the same canonical Person and its first invite is planned', async () => {
    const p = person('maya');
    const contactId = await captured(A, p);
    const listId = await leadList(A, 'Inbound');
    expect((await addToLeadList(A, listId, p)).inserted).toBe(1);
    const row = await lead(A, p.email);
    expect(row.person_id).toBe(contactId);

    const made = await campaign(A, listId, [inviteStep()]);
    expect(made.enrolled).toBe(1);
    await start(A, made.id);
    await runManagedCampaigns(db, A.id, later(1));

    const enrolled = await member(A, made.id, p.email);
    // Admitted, and waiting on the outcome of the invite it just planned.
    expect(enrolled.status).toBe('waiting');
    expect(enrolled.admitted_at).not.toBeNull();
    const planned = await actionsFor(A, enrolled.id);
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({
      kind: 'invite',
      status: 'planned',
      source: 'campaign',
      campaign_member_id: enrolled.id,
      target_ref: row.profile_url
    });
    expect(row.profile_url?.replace(/\/$/, '')).toBe(profileOf(p));
  });

  it('a captured Person added to the list of an already-running campaign is enrolled and planned on the next tick', async () => {
    const first = person('first');
    const listId = await leadList(A, 'Running inbound');
    await addToLeadList(A, listId, first);
    const made = await campaign(A, listId, [inviteStep()]);
    await start(A, made.id);
    await runManagedCampaigns(db, A.id, later(1));

    const p = person('arrival');
    const contactId = await captured(A, p);
    await addToLeadList(A, listId, p);
    expect((await lead(A, p.email)).person_id).toBe(contactId);
    await runManagedCampaigns(db, A.id, later(2));

    const arrived = await member(A, made.id, p.email);
    expect(arrived.status).toBe('waiting');
    expect(arrived.admitted_at).not.toBeNull();
    const planned = await actionsFor(A, arrived.id);
    expect(planned.map((action) => [action.kind, action.status, action.source])).toEqual([
      ['invite', 'planned', 'campaign']
    ]);
  });

  it('the Inbound screen row as sent today (no LinkedIn profile) links the Person but a LinkedIn campaign excludes it', async () => {
    const p = person('noprofile');
    const contactId = await captured(A, p);
    const listId = await leadList(A, 'Inbound no profile');
    await addToLeadList(A, listId, p, false);
    const row = await lead(A, p.email);
    expect(row.person_id).toBe(contactId);
    expect(row.profile_url).toBeNull();

    const made = await campaign(A, listId, [inviteStep()]);
    expect(made.enrolled).toBe(0);
    await start(A, made.id);
    await runManagedCampaigns(db, A.id, later(1));
    const excluded = await member(A, made.id, p.email);
    expect(excluded).toMatchObject({
      status: 'excluded',
      exclusion_reason: 'Missing LinkedIn profile URL'
    });
    expect(await actionsFor(A, excluded.id)).toEqual([]);
  });
});

describe('TRV-029 suppression and Never Contact are honoured at the planning boundary', () => {
  it('"Mark not a lead" before enrolment excludes the member as Workspace suppression and plans nothing', async () => {
    const p = person('before');
    const control = person('control');
    const contactId = await captured(A, p);
    await suppressNotALead(A, contactId, p.email);
    const listId = await leadList(A, 'Suppressed before');
    await addToLeadList(A, listId, p);
    await addToLeadList(A, listId, control);

    const made = await campaign(A, listId, [inviteStep()]);
    expect(made).toMatchObject({ enrolled: 1, excluded: 1 });
    await start(A, made.id);
    await runManagedCampaigns(db, A.id, later(1));

    expect(await member(A, made.id, p.email)).toMatchObject({
      status: 'excluded',
      exclusion_reason: 'Workspace suppression',
      admitted_at: null
    });
    expect(await actionsTargeting(A, p)).toEqual([]);
    // The control lead proves the tick did plan.
    expect((await actionsTargeting(A, control)).map((action) => action.status)).toEqual([
      'planned'
    ]);
  });

  it('"Mark not a lead" after enrolment but before admission is never admitted or planned', async () => {
    const p = person('pending');
    const control = person('control');
    const contactId = await captured(A, p);
    const listId = await leadList(A, 'Suppressed while pending');
    await addToLeadList(A, listId, p);
    await addToLeadList(A, listId, control);
    const made = await campaign(A, listId, [inviteStep()]);
    expect(made.enrolled).toBe(2);
    await start(A, made.id);
    expect((await member(A, made.id, p.email)).status).toBe('pending');

    await suppressNotALead(A, contactId, p.email);
    await runManagedCampaigns(db, A.id, later(1));

    expect(await member(A, made.id, p.email)).toMatchObject({
      status: 'excluded',
      exclusion_reason: 'Workspace suppression',
      admitted_at: null
    });
    expect(await actionsTargeting(A, p)).toEqual([]);
    expect((await actionsTargeting(A, control)).map((action) => action.status)).toEqual([
      'planned'
    ]);
  });

  it('a suppression after admission stops the next step from ever being planned', async () => {
    const p = person('admitted');
    const contactId = await captured(A, p);
    const listId = await leadList(A, 'Suppressed after admission');
    await addToLeadList(A, listId, p);
    // A delayed first step: admitted now, nothing due until tomorrow.
    const made = await campaign(A, listId, [inviteStep({ amount: 1, unit: 'days' })]);
    await start(A, made.id);
    await runManagedCampaigns(db, A.id, later(1));
    const admitted = await member(A, made.id, p.email);
    expect(admitted.status).toBe('active');
    expect(admitted.admitted_at).not.toBeNull();
    expect(await actionsFor(A, admitted.id)).toEqual([]);

    await suppressNotALead(A, contactId, p.email);
    await runManagedCampaigns(db, A.id, new Date(Date.now() + 2 * DAY));

    expect(await member(A, made.id, p.email)).toMatchObject({
      status: 'excluded',
      exclusion_reason: 'Workspace suppression'
    });
    expect(await actionsTargeting(A, p)).toEqual([]);
  });

  it('a suppression after an invite was planned retires the member and skips the unclaimed invite', async () => {
    const p = person('queued');
    const contactId = await captured(A, p);
    const listId = await leadList(A, 'Suppressed after planning');
    await addToLeadList(A, listId, p);
    const made = await campaign(A, listId, [inviteStep()]);
    await start(A, made.id);
    await runManagedCampaigns(db, A.id, later(1));
    const queued = await member(A, made.id, p.email);
    expect((await actionsFor(A, queued.id)).map((action) => action.status)).toEqual(['planned']);

    await suppressNotALead(A, contactId, p.email);
    await runManagedCampaigns(db, A.id, later(2));

    expect(await member(A, made.id, p.email)).toMatchObject({
      status: 'excluded',
      exclusion_reason: 'Workspace suppression'
    });
    expect((await actionsFor(A, queued.id)).map((action) => action.status)).toEqual(['skipped']);
  });

  it('an email-only all-channel suppression (no Person id given) blocks a lead carrying that email, before and after enrolment', async () => {
    const early = person('emailearly');
    const late = person('emaillate');
    const control = person('control');
    const listId = await leadList(A, 'Email suppression');
    await as(A)
      .post('/api/suppressions')
      .send({ channel: 'all', email: early.email, reason: 'Email-only suppression' })
      .expect(201);
    for (const p of [early, late, control]) await addToLeadList(A, listId, p);
    const made = await campaign(A, listId, [inviteStep()]);
    expect(made).toMatchObject({ enrolled: 2, excluded: 1 });
    await start(A, made.id);
    await as(A)
      .post('/api/suppressions')
      .send({ channel: 'all', email: late.email, reason: 'Email-only suppression' })
      .expect(201);
    await runManagedCampaigns(db, A.id, later(1));

    for (const p of [early, late]) {
      expect(await member(A, made.id, p.email)).toMatchObject({
        status: 'excluded',
        exclusion_reason: 'Workspace suppression'
      });
      expect(await actionsTargeting(A, p)).toEqual([]);
    }
    expect((await actionsTargeting(A, control)).map((action) => action.status)).toEqual([
      'planned'
    ]);
  });

  it('Never Contact on the profile, before or after enrolment, is never planned', async () => {
    const early = person('neverearly');
    const late = person('neverlate');
    const control = person('control');
    const listId = await leadList(A, 'Never contact');
    for (const p of [early, late, control]) {
      await captured(A, p);
      await addToLeadList(A, listId, p);
    }
    await as(A)
      .post('/api/linkedin/exclusions')
      .send({ targets: [{ targetRef: profileOf(early), reason: 'Asked to be left alone' }] })
      .expect(201);
    const made = await campaign(A, listId, [inviteStep()]);
    expect(made).toMatchObject({ enrolled: 2, excluded: 1 });
    await start(A, made.id);
    await as(A)
      .post('/api/linkedin/exclusions')
      .send({ targets: [{ targetRef: `${profileOf(late)}/?trk=feed`, reason: 'Competitor' }] })
      .expect(201);
    await runManagedCampaigns(db, A.id, later(1));

    expect(await member(A, made.id, early.email)).toMatchObject({
      status: 'excluded',
      exclusion_reason: 'Never contact: Asked to be left alone'
    });
    expect(await member(A, made.id, late.email)).toMatchObject({
      status: 'excluded',
      exclusion_reason: 'Never contact: Competitor'
    });
    expect(await actionsTargeting(A, early)).toEqual([]);
    expect(await actionsTargeting(A, late)).toEqual([]);
    expect((await actionsTargeting(A, control)).map((action) => action.status)).toEqual([
      'planned'
    ]);
  });

  it('marking an enrolled lead do-not-contact stops it from being planned', async () => {
    const p = person('dnc');
    const listId = await leadList(A, 'Do not contact');
    await addToLeadList(A, listId, p);
    const made = await campaign(A, listId, [inviteStep()]);
    await start(A, made.id);
    const row = await lead(A, p.email);
    await as(A)
      .patch(`/api/linkedin/manager/contacts/${row.id}`)
      .send({
        firstName: p.first,
        lastName: p.last,
        company: p.company,
        email: p.email,
        profileUrl: profileOf(p),
        doNotContact: true
      })
      .expect(200);
    await runManagedCampaigns(db, A.id, later(1));

    const retired = await member(A, made.id, p.email);
    expect(retired.status).toBe('excluded');
    // The DNC flag also writes a LinkedIn-channel suppression, which outranks the flag.
    expect(['Workspace suppression', 'Do not contact']).toContain(retired.exclusion_reason);
    expect(await actionsTargeting(A, p)).toEqual([]);
  });

  it('the email leg never queues a channel action for a suppressed member', async () => {
    const p = person('mailsup');
    const control = person('mailok');
    const emailOnly = person('mailchannel');
    const contactId = await captured(A, p);
    const listId = await leadList(A, 'Email leg');
    for (const lead of [p, control, emailOnly]) await addToLeadList(A, listId, lead);
    // A real connection row whose mailbox may send zero emails a day: the email
    // planner runs for real, and nothing ever leaves.
    const connectionId = `conn_${A.id}`;
    await db
      .prepare(
        "INSERT INTO connections(id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,mailbox_address,created_at,updated_at) VALUES (?,?,'gmail','trevra-gmail','test-mailbox','Fake mailbox','connected',0,'sender@acme.test',now(),now())"
      )
      .run(connectionId, A.id);
    await db
      .prepare(
        'INSERT INTO linkedin_campaign_mailbox_settings(workspace_id,connection_id,daily_limit) VALUES (?,?,0)'
      )
      .run(A.id, connectionId);
    const made = await campaign(A, listId, [emailStep], {
      mailboxAssignments: { owner: connectionId }
    });
    expect(made.enrolled).toBe(3);
    await start(A, made.id);
    await suppressNotALead(A, contactId, p.email);
    await as(A)
      .post('/api/suppressions')
      .send({ channel: 'email', email: emailOnly.email, reason: 'Email opt-out only' })
      .expect(201);
    await runManagedCampaigns(db, A.id, later(1));

    const suppressed = await member(A, made.id, p.email);
    const clean = await member(A, made.id, control.email);
    expect(suppressed).toMatchObject({
      status: 'excluded',
      exclusion_reason: 'Workspace suppression'
    });
    const channel = (memberId: string) =>
      count(
        'SELECT COUNT(*)::int AS n FROM linkedin_campaign_channel_actions WHERE workspace_id=? AND member_id=?',
        A.id,
        memberId
      );
    expect(await channel(suppressed.id)).toBe(0);
    // The control member's email was planned (and held: its mailbox may send zero a day).
    expect(await channel(clean.id)).toBe(1);
    // Observed: an email-channel-only suppression is not a LinkedIn exclusion, so
    // the member stays live and its email step is still queued; the refusal for
    // that channel happens at execution (`executeEmail` -> assertNotSuppressed).
    const emailSuppressed = await member(A, made.id, emailOnly.email);
    expect(emailSuppressed.status).not.toBe('excluded');
    expect(await channel(emailSuppressed.id)).toBe(1);
  });

  it('a lifted suppression does not by itself restore an excluded member (observed behaviour)', async () => {
    const p = person('lifted');
    const contactId = await captured(A, p);
    const suppression = await suppressNotALead(A, contactId, p.email);
    const listId = await leadList(A, 'Lifted');
    await addToLeadList(A, listId, p);
    const made = await campaign(A, listId, [inviteStep()]);
    await start(A, made.id);
    await runManagedCampaigns(db, A.id, later(1));
    expect((await member(A, made.id, p.email)).exclusion_reason).toBe('Workspace suppression');

    await as(A).delete(`/api/suppressions/${suppression.id}`).expect(200);
    await runManagedCampaigns(db, A.id, later(2));
    // Eligibility is recomputed only on list growth, a lead edit or a paused
    // campaign edit, so a lift alone leaves the member excluded and unplanned.
    expect(await member(A, made.id, p.email)).toMatchObject({
      status: 'excluded',
      exclusion_reason: 'Workspace suppression'
    });
    expect(await actionsTargeting(A, p)).toEqual([]);
  });
});

describe('TRV-029 workspace isolation', () => {
  it('a submission signed for workspace A never creates People or campaign members in workspace B', async () => {
    const p = person('isolated');
    const listB = await leadList(B, 'B inbound');
    const bystander = person('bystander');
    await addToLeadList(B, listB, bystander);
    const madeB = await campaign(B, listB, [inviteStep()]);
    await start(B, madeB.id);
    const contactsB = await count(
      'SELECT COUNT(*)::int AS n FROM contacts WHERE workspace_id=?',
      B.id
    );

    const contactId = await captured(A, p);
    // A's secret presented under B's source id is not B's capture.
    await capture(
      B.source,
      'forged-001',
      {
        kind: 'demo_request',
        person: { email: p.email }
      },
      A.source.secret
    ).response.expect(401);
    await runManagedCampaigns(db, B.id, later(1));

    expect(await count('SELECT COUNT(*)::int AS n FROM contacts WHERE workspace_id=?', B.id)).toBe(
      contactsB
    );
    expect(
      await count(
        'SELECT COUNT(*)::int AS n FROM contacts WHERE workspace_id=? AND email_normalized=?',
        B.id,
        p.email.toLowerCase()
      )
    ).toBe(0);
    expect(
      await count('SELECT COUNT(*)::int AS n FROM inbound_submissions WHERE workspace_id=?', B.id)
    ).toBe(0);
    expect(
      await count(
        `SELECT COUNT(*)::int AS n FROM linkedin_campaign_members m
         JOIN linkedin_lead_contacts c ON c.id=m.contact_id
         WHERE m.workspace_id=? AND (c.person_id=? OR LOWER(c.email)=LOWER(?))`,
        B.id,
        contactId,
        p.email
      )
    ).toBe(0);
    // A suppression in A is not B's authority either.
    await suppressNotALead(A, contactId, p.email);
    expect(
      await count('SELECT COUNT(*)::int AS n FROM suppressions WHERE workspace_id=?', B.id)
    ).toBe(0);
  });
});

describe('TRV-029 email and Person suppressions stop LinkedIn at the send-time guard', () => {
  it('an email-only suppression written before the Person existed refuses a LinkedIn action at the lead profile carrying that email', async () => {
    const p = person('guardemail');
    const control = person('control');
    const created = await as(A)
      .post('/api/suppressions')
      .send({ channel: 'all', email: p.email, reason: 'Email-only opt-out' })
      .expect(201);
    expect(created.body.suppression.personId).toBeNull();
    const listId = await leadList(A, 'Guard email');
    await addToLeadList(A, listId, p);
    await addToLeadList(A, listId, control);
    expect((await lead(A, p.email)).person_id).toMatch(/^con_/);

    expect(await sendTimeSuppression(A, p)).toMatchObject({
      passed: false,
      detail: expect.stringContaining('Email-only opt-out')
    });
    expect((await sendTimeSuppression(A, control)).passed).toBe(true);

    // An email-channel suppression is the email boundary's business, not LinkedIn's.
    await as(A)
      .post('/api/suppressions')
      .send({ channel: 'email', email: control.email, reason: 'Email channel only' })
      .expect(201);
    expect((await sendTimeSuppression(A, control)).passed).toBe(true);

    // The same profile and email in workspace B is untouched by A's suppression.
    const listB = await leadList(B, 'Guard email B');
    await addToLeadList(B, listB, p);
    expect((await sendTimeSuppression(B, p)).passed).toBe(true);
  });

  it('a Person suppression refuses a LinkedIn action at a lead profile the Person record does not carry', async () => {
    const p = person('guardperson');
    // The Person already holds an older profile, so the lead's newer one is a
    // recorded conflict rather than a fill.
    const resolved = await resolveContact(db, A.id, {
      name: `${p.first} ${p.last}`,
      email: p.email,
      linkedinUrl: `https://www.linkedin.com/in/${p.slug}-old`
    });
    await suppressNotALead(A, resolved.contact.id, null);
    const listId = await leadList(A, 'Guard person');
    await addToLeadList(A, listId, p);
    expect((await lead(A, p.email)).person_id).toBe(resolved.contact.id);
    const canonical = await db
      .prepare('SELECT linkedin_url_normalized FROM contacts WHERE workspace_id=? AND id=?')
      .get<{ linkedin_url_normalized: string }>(A.id, resolved.contact.id);
    expect(canonical?.linkedin_url_normalized).toBe(`https://www.linkedin.com/in/${p.slug}-old/`);

    expect((await sendTimeSuppression(A, p)).passed).toBe(false);
    expect((await sendTimeSuppression(B, p)).passed).toBe(true);
  });

  it("an email-only suppression matching the linked Person's email, not the lead's, retires the member and refuses the send", async () => {
    const p = person('personemail');
    const control = person('control');
    const listId = await leadList(A, 'Person email');
    await addToLeadList(A, listId, p, true, false);
    await addToLeadList(A, listId, control);
    const row = await leadByProfile(A, p);
    expect(row.email).toBeNull();
    expect(row.person_id).toMatch(/^con_/);
    const made = await campaign(A, listId, [inviteStep()]);
    await start(A, made.id);
    await runManagedCampaigns(db, A.id, later(1));
    const queued = await memberByContact(A, made.id, row.id);
    expect((await actionsFor(A, queued.id)).map((action) => action.status)).toEqual(['planned']);

    // The opt-out arrives for an address no Person holds yet, so it is email-only...
    const created = await as(A)
      .post('/api/suppressions')
      .send({ channel: 'all', email: p.email, reason: 'Email-only opt-out' })
      .expect(201);
    expect(created.body.suppression.personId).toBeNull();
    // ...and later evidence gives the lead's Person that address. The lead row
    // itself never carries it.
    const resolved = await resolveContact(db, A.id, { email: p.email, linkedinUrl: profileOf(p) });
    expect(resolved.contact.id).toBe(row.person_id);
    expect((await leadByProfile(A, p)).email).toBeNull();

    expect((await sendTimeSuppression(A, p)).passed).toBe(false);
    await runManagedCampaigns(db, A.id, later(2));
    expect(await memberByContact(A, made.id, row.id)).toMatchObject({
      status: 'excluded',
      exclusion_reason: 'Workspace suppression'
    });
    expect((await actionsFor(A, queued.id)).map((action) => action.status)).toEqual(['skipped']);
    expect((await sendTimeSuppression(A, control)).passed).toBe(true);
  });
});

describe('TRV-029 auto-enrol rules enrol new leads into a chosen campaign through admission', () => {
  it('a capture-source rule enrols each new capture into the running campaign once, through the same eligibility, with one event', async () => {
    const { id: campaignId, listId } = await runningCampaign(A, 'Auto capture');
    const rule = await autoRule(A, campaignId, 'capture_source', A.source.id);
    expect(rule).toMatchObject({
      campaignId,
      sourceKind: 'capture_source',
      sourceId: A.source.id,
      status: 'active'
    });

    const known = person('autoknown');
    const personId = await knownWithProfile(A, known);
    const key = `cap-${known.slug}`;
    const accepted = await capture(A.source, key, captureBody(known)).response.expect(202);
    expect(accepted.body.personId).toBe(personId);

    // Placed in the campaign's own list as the same canonical Person, and
    // enrolled at once -- pending admission, exactly like a manual import.
    const row = await lead(A, known.email);
    expect(row.person_id).toBe(personId);
    expect(row.profile_url?.replace(/\/$/, '')).toBe(profileOf(known));
    expect(
      await count(
        'SELECT COUNT(*)::int AS n FROM linkedin_lead_list_members WHERE workspace_id=? AND list_id=? AND contact_id=?',
        A.id,
        listId,
        row.id
      )
    ).toBe(1);
    const enrolled = await member(A, campaignId, known.email);
    expect(enrolled).toMatchObject({
      status: 'pending',
      exclusion_reason: null,
      admitted_at: null
    });
    const events = await autoEnrolEvents(A, campaignId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      stream_type: 'linkedin_campaign_member',
      stream_id: enrolled.id,
      actor_type: 'system',
      actor_id: rule.id,
      correlation_id: accepted.body.submissionId
    });
    expect(events[0].payload_json).toMatchObject({
      ruleId: rule.id,
      campaignId,
      memberId: enrolled.id,
      personId,
      status: 'pending'
    });

    // A sender retry is a duplicate submission; a second, distinct capture of
    // the same Person finds the member already there. Neither enrols again.
    await capture(A.source, key, captureBody(known)).response.expect(200);
    await capture(A.source, `${key}-again`, captureBody(known)).response.expect(202);
    expect(await autoEnrolEvents(A, campaignId)).toHaveLength(1);
    expect(await membersWithEmail(A, campaignId, known.email)).toBe(1);

    // Same eligibility as any lead: a capture with no LinkedIn profile is
    // enrolled as excluded, never planned.
    const bare = person('autobare');
    await captured(A, bare);
    expect(await member(A, campaignId, bare.email)).toMatchObject({
      status: 'excluded',
      exclusion_reason: 'Missing LinkedIn profile URL'
    });
    expect(
      (await autoEnrolEvents(A, campaignId)).map((event) => event.payload_json.status)
    ).toEqual(['pending', 'excluded']);

    // A source with no rule enrols nobody.
    const other = person('autoother');
    await knownWithProfile(A, other);
    await capture(A.webinar, `cap-${other.slug}`, captureBody(other)).response.expect(202);
    expect(await membersWithEmail(A, campaignId, other.email)).toBe(0);

    // The runner admits and plans the enrolled Person like any other member.
    await runManagedCampaigns(db, A.id, later(1));
    const admitted = await member(A, campaignId, known.email);
    expect(admitted.status).toBe('waiting');
    expect(
      (await actionsFor(A, admitted.id)).map((action) => [action.kind, action.status])
    ).toEqual([['invite', 'planned']]);
    expect(await actionsTargeting(A, bare)).toEqual([]);
  });

  it('a suppressed Person captured through a rule is enrolled as excluded and never planned', async () => {
    const { id: campaignId } = await runningCampaign(A, 'Auto suppressed');
    await autoRule(A, campaignId, 'capture_source', A.source.id);
    const p = person('autosup');
    const personId = await knownWithProfile(A, p);
    await suppressNotALead(A, personId, p.email);
    await captured(A, p);
    expect(await member(A, campaignId, p.email)).toMatchObject({
      status: 'excluded',
      exclusion_reason: 'Workspace suppression'
    });
    await runManagedCampaigns(db, A.id, later(1));
    expect(await actionsTargeting(A, p)).toEqual([]);
  });

  it('a rule never enrols into a paused or stopped campaign, and a disabled rule stops enrolling', async () => {
    const { id: campaignId } = await runningCampaign(A, 'Auto paused');
    const rule = await autoRule(A, campaignId, 'capture_source', A.source.id);
    await as(A).post(`/api/linkedin/manager/campaigns/${campaignId}/pause`).send({}).expect(200);
    const whilePaused = person('autopaused');
    await knownWithProfile(A, whilePaused);
    await captured(A, whilePaused);
    expect(await membersWithEmail(A, campaignId, whilePaused.email)).toBe(0);

    // Arrivals during the pause are not a backlog that fires on resume.
    await start(A, campaignId);
    await runManagedCampaigns(db, A.id, later(1));
    expect(await membersWithEmail(A, campaignId, whilePaused.email)).toBe(0);
    const afterResume = person('autoresumed');
    await knownWithProfile(A, afterResume);
    await captured(A, afterResume);
    expect((await member(A, campaignId, afterResume.email)).status).toBe('pending');

    const disabled = await as(A)
      .post(`/api/linkedin/manager/auto-enrol-rules/${rule.id}/disable`)
      .send({})
      .expect(200);
    expect(disabled.body.rule).toMatchObject({ id: rule.id, status: 'disabled' });
    await as(A)
      .post(`/api/linkedin/manager/auto-enrol-rules/${rule.id}/disable`)
      .send({})
      .expect(404);
    const listed = await as(A)
      .get(`/api/linkedin/manager/campaigns/${campaignId}/auto-enrol-rules`)
      .expect(200);
    expect(listed.body.rules.map((entry: AutoRule) => [entry.id, entry.status])).toEqual([
      [rule.id, 'disabled']
    ]);
    const afterDisable = person('autodisabled');
    await knownWithProfile(A, afterDisable);
    await captured(A, afterDisable);
    expect(await membersWithEmail(A, campaignId, afterDisable.email)).toBe(0);

    // A stopped campaign takes no new rule, and an active one on it enrols nobody.
    await autoRule(A, campaignId, 'capture_source', A.webinar.id);
    await as(A).post(`/api/linkedin/manager/campaigns/${campaignId}/stop`).send({}).expect(200);
    const afterStop = person('autostopped');
    await knownWithProfile(A, afterStop);
    await capture(A.webinar, `cap-${afterStop.slug}`, captureBody(afterStop)).response.expect(202);
    expect(await membersWithEmail(A, campaignId, afterStop.email)).toBe(0);
    expect(
      (
        await as(A)
          .post(`/api/linkedin/manager/campaigns/${campaignId}/auto-enrol-rules`)
          .send({ sourceKind: 'capture_source', sourceId: A.source.id })
      ).status
    ).toBe(409);
    expect(await autoEnrolEvents(A, campaignId)).toHaveLength(1);
  });

  it('a lead-list rule enrols leads as they land in the source list, through the same eligibility, once', async () => {
    const { id: campaignId, listId } = await runningCampaign(A, 'Auto list');
    const sourceList = await leadList(A, 'Webinar attendees');
    // The campaign's own list already enrols on every tick.
    expect(
      (
        await as(A)
          .post(`/api/linkedin/manager/campaigns/${campaignId}/auto-enrol-rules`)
          .send({ sourceKind: 'lead_list', sourceId: listId })
      ).status
    ).toBe(400);
    const rule = await autoRule(A, campaignId, 'lead_list', sourceList);
    // One active rule per source and campaign.
    expect(
      (
        await as(A)
          .post(`/api/linkedin/manager/campaigns/${campaignId}/auto-enrol-rules`)
          .send({ sourceKind: 'lead_list', sourceId: sourceList })
      ).status
    ).toBe(409);

    const p = person('autolist');
    const suppressed = person('autolistsup');
    await as(A)
      .post('/api/suppressions')
      .send({ channel: 'all', email: suppressed.email, reason: 'Opted out' })
      .expect(201);
    await addToLeadList(A, sourceList, p);
    await addToLeadList(A, sourceList, suppressed);

    expect(await member(A, campaignId, p.email)).toMatchObject({
      status: 'pending',
      exclusion_reason: null
    });
    expect(await member(A, campaignId, suppressed.email)).toMatchObject({
      status: 'excluded',
      exclusion_reason: 'Workspace suppression'
    });
    // In the campaign's list as the same lead row, not a copy.
    expect(
      await count(
        'SELECT COUNT(*)::int AS n FROM linkedin_lead_list_members WHERE workspace_id=? AND list_id=? AND contact_id=?',
        A.id,
        listId,
        (await lead(A, p.email)).id
      )
    ).toBe(1);
    expect(
      (await autoEnrolEvents(A, campaignId)).map((event) => [
        event.payload_json.status,
        event.actor_id
      ])
    ).toEqual([
      ['pending', rule.id],
      ['excluded', rule.id]
    ]);

    // Re-importing the same row is a duplicate and enrols nobody twice.
    await addToLeadList(A, sourceList, p);
    expect(await autoEnrolEvents(A, campaignId)).toHaveLength(2);

    await runManagedCampaigns(db, A.id, later(1));
    expect((await actionsTargeting(A, p)).map((action) => [action.kind, action.status])).toEqual([
      ['invite', 'planned']
    ]);
    expect(await actionsTargeting(A, suppressed)).toEqual([]);
  });

  it("refuses another workspace's campaign, capture source or lead list, and B's captures never enrol into A", async () => {
    const { id: campaignId } = await runningCampaign(A, 'Auto isolated');
    const listB = await leadList(B, 'B list');
    for (const body of [
      { sourceKind: 'capture_source', sourceId: B.source.id },
      { sourceKind: 'lead_list', sourceId: listB }
    ])
      expect(
        (
          await as(A)
            .post(`/api/linkedin/manager/campaigns/${campaignId}/auto-enrol-rules`)
            .send(body)
        ).status
      ).toBe(404);
    expect(
      (
        await as(B)
          .post(`/api/linkedin/manager/campaigns/${campaignId}/auto-enrol-rules`)
          .send({ sourceKind: 'capture_source', sourceId: B.source.id })
      ).status
    ).toBe(404);
    expect(
      (await as(B).get(`/api/linkedin/manager/campaigns/${campaignId}/auto-enrol-rules`)).status
    ).toBe(404);
    const rule = await autoRule(A, campaignId, 'capture_source', A.source.id);
    expect(
      (await as(B).post(`/api/linkedin/manager/auto-enrol-rules/${rule.id}/disable`).send({}))
        .status
    ).toBe(404);

    const p = person('autoiso');
    await knownWithProfile(B, p);
    await captured(B, p);
    expect(
      await count(
        'SELECT COUNT(*)::int AS n FROM linkedin_campaign_members WHERE campaign_id=?',
        campaignId
      )
    ).toBe(1);
    expect(
      await count(
        'SELECT COUNT(*)::int AS n FROM linkedin_lead_contacts WHERE workspace_id=? AND LOWER(email)=LOWER(?)',
        A.id,
        p.email
      )
    ).toBe(0);
  });
});

describe('TRV-029 account-import People reach campaigns through a lead list', () => {
  it('account import with a lead list places the imported People in it, and the running campaign on that list enrols them on the next tick', async () => {
    const { id: campaignId, listId } = await runningCampaign(A, 'Imported people');
    const linkedPerson = person('importlinked');
    const personId = await knownWithProfile(A, linkedPerson);
    const bareEmail = `bare-${randomBytes(3).toString('hex')}@import2.example`;
    const body = {
      text: 'import2.example',
      leadListId: listId,
      people: [
        {
          accountDomain: 'import2.example',
          name: `${linkedPerson.first} ${linkedPerson.last}`,
          email: linkedPerson.email
        },
        { accountDomain: 'import2.example', name: 'Bare Importee', email: bareEmail }
      ]
    };
    const imported = await as(A).post('/api/accounts/import').send(body);
    expect(imported.status, JSON.stringify(imported.body)).toBe(201);
    expect(imported.body.people).toEqual({ created: 1, matched: 1, linked: 2, skipped: 0 });
    expect(imported.body.leadList).toEqual({
      listId,
      inserted: 2,
      reused: 0,
      duplicates: 0,
      skipped: 0
    });

    const linked = await lead(A, linkedPerson.email);
    expect(linked.person_id).toBe(personId);
    expect(linked.profile_url?.replace(/\/$/, '')).toBe(profileOf(linkedPerson));
    const bareContact = await db
      .prepare('SELECT id FROM contacts WHERE workspace_id=? AND email_normalized=?')
      .get<{ id: string }>(A.id, bareEmail);
    expect((await lead(A, bareEmail)).person_id).toBe(bareContact?.id);

    await runManagedCampaigns(db, A.id, later(1));
    const enrolled = await member(A, campaignId, linkedPerson.email);
    expect(enrolled.status).toBe('waiting');
    expect(
      (await actionsFor(A, enrolled.id)).map((action) => [action.kind, action.status])
    ).toEqual([['invite', 'planned']]);
    // Same eligibility as any lead: no LinkedIn profile, no LinkedIn step.
    expect(await member(A, campaignId, bareEmail)).toMatchObject({
      status: 'excluded',
      exclusion_reason: 'Missing LinkedIn profile URL'
    });

    const again = await as(A).post('/api/accounts/import').send(body).expect(200);
    expect(again.body.leadList).toEqual({
      listId,
      inserted: 0,
      reused: 0,
      duplicates: 2,
      skipped: 0
    });
    expect(
      await count(
        'SELECT COUNT(*)::int AS n FROM linkedin_lead_contacts WHERE workspace_id=? AND LOWER(email)=LOWER(?)',
        A.id,
        bareEmail
      )
    ).toBe(1);
  });

  it("refuses another workspace's lead list before writing anything", async () => {
    const listB = await leadList(B, 'B import list');
    const email = `iso-${randomBytes(3).toString('hex')}@import3.example`;
    const refused = await as(A)
      .post('/api/accounts/import')
      .send({
        text: 'import3.example',
        leadListId: listB,
        people: [{ accountDomain: 'import3.example', name: 'Iso Person', email }]
      });
    expect(refused.status).toBe(404);
    expect(
      await count(
        'SELECT COUNT(*)::int AS n FROM contacts WHERE workspace_id=? AND email_normalized=?',
        A.id,
        email
      )
    ).toBe(0);
    expect(
      await count(
        "SELECT COUNT(*)::int AS n FROM accounts WHERE workspace_id=? AND domain='import3.example'",
        A.id
      )
    ).toBe(0);
    expect(
      await count(
        'SELECT COUNT(*)::int AS n FROM linkedin_lead_list_members WHERE list_id=?',
        listB
      )
    ).toBe(0);
  });
});
