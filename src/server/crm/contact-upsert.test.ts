import { createHash, randomBytes } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * An in-memory HubSpot + Attio behind a fake Nango proxy. Non-2xx answers
 * reject the way axios does (`error.response`), and failures can be injected
 * before or after a write lands (a lost response).
 */
const crm = vi.hoisted(() => {
  type Props = Record<string, string>;
  interface HubspotContact {
    id: string;
    properties: Props;
    mergedInto?: string;
  }
  interface AttioPerson {
    id: string;
    values: Record<string, Array<Record<string, string>>>;
    companyName?: string;
  }
  interface Failure {
    method?: string;
    endpoint: RegExp;
    status?: number;
    data?: unknown;
    network?: boolean;
    afterApply?: boolean;
  }
  const state = {
    hubspot: new Map<string, HubspotContact>(),
    attio: new Map<string, AttioPerson>(),
    nextId: 1000,
    failures: [] as Failure[],
    calls: [] as Array<{
      method: string;
      endpoint: string;
      providerConfigKey: string;
      connectionId: string;
      data?: unknown;
    }>
  };

  const lower = (value: unknown) => String(value ?? '').toLowerCase();
  const answer = (status: number, data: unknown) => ({ status, data });

  function httpError(status: number, data: unknown): Error {
    return Object.assign(new Error(`Request failed with status code ${status}`), {
      response: { status, data }
    });
  }

  function hubspotView(contact: HubspotContact) {
    return { id: contact.id, properties: { ...contact.properties } };
  }

  function hubspot(method: string, endpoint: string, data: any) {
    if (method === 'POST' && endpoint === '/crm/v3/objects/contacts/search') {
      const filters = data.filterGroups[0].filters as Array<{
        propertyName: string;
        operator: string;
        value?: string;
        values?: string[];
      }>;
      const results = [...state.hubspot.values()].filter(
        (contact) =>
          !contact.mergedInto &&
          filters.every((filter) => {
            const value = lower(contact.properties[filter.propertyName]);
            if (!value) return false;
            if (filter.operator === 'EQ') return value === lower(filter.value);
            return (filter.values ?? []).map(lower).includes(value);
          })
      );
      return answer(200, { total: results.length, results: results.map(hubspotView) });
    }
    const byId = /^\/crm\/v3\/objects\/contacts\/([^/]+)$/.exec(endpoint);
    if (method === 'GET' && byId) {
      const contact = state.hubspot.get(decodeURIComponent(byId[1]!));
      if (!contact) return answer(404, { category: 'OBJECT_NOT_FOUND' });
      const survivor = contact.mergedInto ? state.hubspot.get(contact.mergedInto)! : contact;
      return answer(200, hubspotView(survivor));
    }
    if (method === 'POST' && endpoint === '/crm/v3/objects/contacts') {
      const properties = data.properties as Props;
      const existing = [...state.hubspot.values()].find(
        (contact) => properties.email && lower(contact.properties.email) === lower(properties.email)
      );
      if (existing)
        return answer(409, {
          category: 'CONFLICT',
          message: `Contact already exists. Existing ID: ${existing.id}`
        });
      const contact = { id: String(state.nextId++), properties: { ...properties } };
      state.hubspot.set(contact.id, contact);
      return answer(201, hubspotView(contact));
    }
    if (method === 'PATCH' && byId) {
      const contact = state.hubspot.get(decodeURIComponent(byId[1]!));
      if (!contact) return answer(404, { category: 'OBJECT_NOT_FOUND' });
      Object.assign(contact.properties, data.properties);
      return answer(200, hubspotView(contact));
    }
    return answer(400, { category: 'UNEXPECTED_ROUTE' });
  }

  function attioView(person: AttioPerson) {
    return { id: { record_id: person.id }, values: person.values };
  }

  function attioMatches(person: AttioPerson, filter: any): boolean {
    if (filter.$or) return filter.$or.some((item: unknown) => attioMatches(person, item));
    if (filter.$and) return filter.$and.every((item: unknown) => attioMatches(person, item));
    if (filter.path) return lower(person.companyName) === lower(filter.constraints.value);
    if (filter.linkedin)
      return lower(person.values.linkedin?.[0]?.value) === lower(filter.linkedin.$eq);
    if (filter.email_addresses)
      return (person.values.email_addresses ?? []).some(
        (entry) => lower(entry.email_address) === lower(filter.email_addresses.email_address.$eq)
      );
    if (filter.name) {
      const part = Object.keys(filter.name)[0]!;
      const value = lower(person.values.name?.[0]?.[part]);
      return value !== '' && value === lower(filter.name[part].$eq);
    }
    return false;
  }

  function attioValues(values: Record<string, any>): AttioPerson['values'] {
    const out: AttioPerson['values'] = {};
    if (values.name) out.name = values.name;
    if (values.email_addresses)
      out.email_addresses = values.email_addresses.map((email: string) => ({
        email_address: email
      }));
    if (values.job_title !== undefined) out.job_title = [{ value: values.job_title }];
    if (values.linkedin !== undefined) out.linkedin = [{ value: values.linkedin }];
    if (values.phone_numbers) out.phone_numbers = values.phone_numbers;
    return out;
  }

  function attio(method: string, endpoint: string, data: any) {
    if (method === 'POST' && endpoint === '/v2/objects/people/records/query') {
      const people = [...state.attio.values()].filter((person) =>
        attioMatches(person, data.filter)
      );
      return answer(200, { data: people.map(attioView) });
    }
    const byId = /^\/v2\/objects\/people\/records\/([^/]+)$/.exec(endpoint);
    if (method === 'GET' && byId) {
      const person = state.attio.get(decodeURIComponent(byId[1]!));
      return person ? answer(200, { data: attioView(person) }) : answer(404, { code: 'not_found' });
    }
    if (method === 'POST' && endpoint === '/v2/objects/people/records') {
      const values = attioValues(data.data.values);
      const email = values.email_addresses?.[0]?.email_address;
      if (
        email &&
        [...state.attio.values()].some((person) =>
          (person.values.email_addresses ?? []).some(
            (entry) => lower(entry.email_address) === lower(email)
          )
        )
      )
        return answer(400, { code: 'uniqueness_conflict' });
      const person = { id: `att_${state.nextId++}`, values };
      state.attio.set(person.id, person);
      return answer(200, { data: attioView(person) });
    }
    if (method === 'PATCH' && byId) {
      const person = state.attio.get(decodeURIComponent(byId[1]!));
      if (!person) return answer(404, { code: 'not_found' });
      Object.assign(person.values, attioValues(data.data.values));
      return answer(200, { data: attioView(person) });
    }
    return answer(400, { code: 'unexpected_route' });
  }

  const proxy = vi.fn(async (config: Record<string, any>) => {
    const method = String(config.method).toUpperCase();
    const endpoint = String(config.endpoint);
    state.calls.push({
      method,
      endpoint,
      providerConfigKey: config.providerConfigKey,
      connectionId: config.connectionId,
      data: config.data
    });
    const index = state.failures.findIndex(
      (failure) => (!failure.method || failure.method === method) && failure.endpoint.test(endpoint)
    );
    const failure = index >= 0 ? state.failures.splice(index, 1)[0] : undefined;
    const fail = () => {
      if (failure!.network) throw new Error('socket hang up');
      throw httpError(failure!.status ?? 500, failure!.data ?? {});
    };
    if (failure && !failure.afterApply) fail();
    const result =
      config.providerConfigKey === 'trevra-attio'
        ? attio(method, endpoint, config.data)
        : hubspot(method, endpoint, config.data);
    if (failure) fail();
    if (result.status >= 400) throw httpError(result.status, result.data);
    return result;
  });

  return { state, proxy };
});

vi.mock('@nangohq/node', () => ({
  Nango: class {
    proxy = crm.proxy;
  }
}));

import { closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { createApp } from '../app.js';
import { canonicalPayloadHash } from '../control-plane/payload.js';
import { isRetryableExecutionError } from '../control-plane/execution.js';
import { openDatabase, type Db } from '../db.js';
import { seedPlaybooks } from '../playbooks/registry.js';
import { CrmUpsertError } from './contact-providers.js';
import { executeCrmContactUpsert } from './contact-upsert-execute.js';

let db: Db;
let app: Express;
let session = '';
const WORKSPACE = 'ws_crm_upsert';
const OTHER = 'ws_crm_upsert_other';
const USER = 'usr_crm_upsert';
const NOW = new Date('2026-10-31T09:00:00.000Z').toISOString();
const HUBSPOT = `con_crm_hubspot_${WORKSPACE}`;
const ATTIO = `con_crm_attio_${WORKSPACE}`;

async function seedSession(): Promise<string> {
  for (const [workspaceId, name] of [
    [WORKSPACE, 'CRM upsert'],
    [OTHER, 'Other CRM upsert']
  ] as const) {
    await db
      .prepare(
        'INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING'
      )
      .run(workspaceId, name, NOW);
  }
  await db
    .prepare(
      'INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING'
    )
    .run(USER, WORKSPACE, 'crm-upsert@example.test', 'CRM upsert', NOW);
  const token = randomBytes(32).toString('hex');
  await db
    .prepare('INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)')
    .run(
      createHash('sha256').update(token).digest('hex'),
      USER,
      new Date(Date.now() + 86_400_000).toISOString(),
      NOW
    );
  return token;
}

function post(path: string, body: object) {
  return request(app).post(path).set('Cookie', `trevra_session=${session}`).send(body);
}

async function seedConnection(
  provider: string,
  options: { workspaceId?: string; id?: string; status?: string; demo?: boolean } = {}
): Promise<string> {
  const workspaceId = options.workspaceId ?? WORKSPACE;
  const connectionId = options.id ?? `con_crm_${provider}_${workspaceId}`;
  await db
    .prepare(
      `INSERT INTO connections
       (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      connectionId,
      workspaceId,
      provider,
      `trevra-${provider}`,
      `${provider}-external-${connectionId}`,
      provider,
      options.status ?? 'connected',
      options.demo ? 1 : 0,
      NOW,
      NOW
    );
  return connectionId;
}

async function seedLead(
  id: string,
  lead: {
    firstName: string;
    lastName: string;
    company: string;
    email?: string | null;
    phone?: string | null;
    profileUrl?: string | null;
    title?: string;
  },
  workspaceId = WORKSPACE
): Promise<string> {
  await db
    .prepare(
      `INSERT INTO linkedin_lead_contacts
       (id,workspace_id,list_id,first_name,last_name,company,email,phone,profile_url,dedupe_key,
        custom_fields_json,created_at,updated_at)
       VALUES (?,?,NULL,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      workspaceId,
      lead.firstName,
      lead.lastName,
      lead.company,
      lead.email ?? null,
      lead.phone ?? null,
      lead.profileUrl ?? null,
      id,
      JSON.stringify(lead.title ? { title: lead.title } : {}),
      NOW,
      NOW
    );
  return id;
}

function hubspotContact(id: string, properties: Record<string, string>) {
  crm.state.hubspot.set(id, { id, properties });
}

const JANE = {
  firstName: 'Jane',
  lastName: 'Doe',
  company: 'Acme',
  email: 'Jane@Acme.com',
  phone: '+1 415 555 0100',
  profileUrl: 'https://www.linkedin.com/in/jane-doe/',
  title: 'VP Sales'
};

function writeCalls() {
  return crm.state.calls.filter(
    (call) =>
      call.method !== 'GET' &&
      !call.endpoint.endsWith('/search') &&
      !call.endpoint.endsWith('/query')
  );
}

async function ledger(leadContactId: string) {
  return (await db
    .prepare(
      `SELECT * FROM crm_contact_upserts WHERE workspace_id=? AND lead_contact_id=?
       ORDER BY created_at DESC, id DESC LIMIT 1`
    )
    .get<Record<string, any>>(WORKSPACE, leadContactId))!;
}

async function approve(runId: string) {
  return post(`/api/playbook-runs/${runId}/steps/approve-crm-upsert/decision`, {
    decision: 'approve'
  });
}

async function actionAttempts(runId: string) {
  return db
    .prepare(
      `SELECT status, attempt, error FROM playbook_step_runs
       WHERE playbook_run_id=? AND step_id='upsert-crm-contact' ORDER BY attempt`
    )
    .all<{ status: string; attempt: number; error: string | null }>(runId);
}

beforeAll(async () => {
  process.env.NANGO_API_KEY = 'crm-upsert-test-key';
  await migrateAuthDatabase();
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  for (const workspaceId of [WORKSPACE, OTHER])
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  app = createApp(db);
  session = await seedSession();
  await seedPlaybooks(db, new Date(NOW));
});

beforeEach(async () => {
  crm.proxy.mockClear();
  crm.state.hubspot.clear();
  crm.state.attio.clear();
  crm.state.failures.length = 0;
  crm.state.calls.length = 0;
  for (const table of [
    'crm_contact_links',
    'crm_contact_upserts',
    'playbook_runs',
    'workspace_policies',
    'linkedin_lead_contacts',
    'connections'
  ])
    await db.prepare(`DELETE FROM ${table} WHERE workspace_id IN (?,?)`).run(WORKSPACE, OTHER);
});

afterAll(async () => {
  delete process.env.NANGO_API_KEY;
  for (const workspaceId of [WORKSPACE, OTHER])
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  await db.close();
  await closeAuthDatabase();
});

describe('crm.upsert-contact prepare: deterministic match tiers', () => {
  it('matches by LinkedIn URL before email and before name + company', async () => {
    await seedConnection('hubspot');
    await seedLead('lead_tiers', JANE);
    hubspotContact('101', { hs_linkedin_url: 'linkedin.com/in/Jane-Doe', email: 'other@x.test' });
    hubspotContact('102', { email: 'jane@acme.com' });
    hubspotContact('103', { firstname: 'Jane', lastname: 'Doe', company: 'Acme' });

    const linkedin = await post('/api/crm/contact-upserts', { leadContactId: 'lead_tiers' });
    expect(linkedin.status).toBe(201);
    expect(linkedin.body.upsert).toMatchObject({
      status: 'prepared',
      operation: 'update',
      matchTier: 'linkedin_url',
      crmRecordId: '101'
    });
    expect(linkedin.body.upsert.plan.tiersSearched).toEqual([
      { tier: 'linkedin_url', outcome: 'matched' }
    ]);
    expect(linkedin.body.run).toMatchObject({
      playbookId: 'gtm.crm-upsert-contact',
      status: 'waiting_approval'
    });

    crm.state.hubspot.delete('101');
    const email = await post('/api/crm/contact-upserts', { leadContactId: 'lead_tiers' });
    expect(email.body.upsert).toMatchObject({ matchTier: 'email', crmRecordId: '102' });
    expect(email.body.upsert.plan.tiersSearched).toEqual([
      { tier: 'linkedin_url', outcome: 'no_match' },
      { tier: 'email', outcome: 'matched' }
    ]);

    crm.state.hubspot.delete('102');
    const name = await post('/api/crm/contact-upserts', { leadContactId: 'lead_tiers' });
    expect(name.body.upsert).toMatchObject({ matchTier: 'name_company', crmRecordId: '103' });

    // Each re-prepare superseded the one before it; nothing was written.
    const statuses = await db
      .prepare(
        'SELECT status FROM crm_contact_upserts WHERE workspace_id=? ORDER BY created_at, id'
      )
      .all<{ status: string }>(WORKSPACE);
    expect(statuses.map((row) => row.status).sort()).toEqual([
      'prepared',
      'superseded',
      'superseded'
    ]);
    expect(writeCalls()).toEqual([]);
  });

  it('blocks an ambiguous tier, keeps the candidates, and writes nothing', async () => {
    await seedConnection('hubspot');
    await seedLead('lead_ambiguous', { ...JANE, profileUrl: null });
    hubspotContact('201', { email: 'jane@acme.com', firstname: 'Jane' });
    hubspotContact('202', { email: 'JANE@acme.com', firstname: 'J.' });
    hubspotContact('203', { firstname: 'Jane', lastname: 'Doe', company: 'Acme' });

    const response = await post('/api/crm/contact-upserts', { leadContactId: 'lead_ambiguous' });
    expect(response.status).toBe(200);
    expect(response.body.run).toBeNull();
    expect(response.body.upsert).toMatchObject({
      status: 'blocked_ambiguous',
      matchTier: 'email',
      payloadHash: null,
      playbookRunId: null
    });
    expect(response.body.upsert.plan.candidates.map((c: { id: string }) => c.id).sort()).toEqual([
      '201',
      '202'
    ]);
    const row = await ledger('lead_ambiguous');
    expect([...row.candidate_ids_json].sort()).toEqual(['201', '202']);
    const runs = await db
      .prepare('SELECT COUNT(*)::int AS n FROM playbook_runs WHERE workspace_id=?')
      .get<{ n: number }>(WORKSPACE);
    expect(runs!.n).toBe(0);
    expect(writeCalls()).toEqual([]);
  });

  it('a deny policy blocks prepare before any CRM read', async () => {
    await seedConnection('hubspot');
    await seedLead('lead_denied', JANE);
    await db
      .prepare(
        `INSERT INTO workspace_policies (id,workspace_id,name,priority,action_pattern,effect,enabled)
         VALUES ('pol_crm_deny',?,'No CRM upserts',100,'action:crm.upsert-contact','deny',TRUE)`
      )
      .run(WORKSPACE);
    const response = await post('/api/crm/contact-upserts', { leadContactId: 'lead_denied' });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('policy_denied');
    expect(crm.state.calls).toEqual([]);
  });
});

describe('crm.upsert-contact execute', () => {
  it('fills only empty fields and never overwrites a value or the email', async () => {
    await seedConnection('hubspot');
    await seedLead('lead_fill', JANE);
    hubspotContact('301', {
      hs_linkedin_url: 'https://www.linkedin.com/in/jane-doe',
      firstname: 'Janet',
      lastname: 'Doe',
      email: 'j.doe@personal.test',
      company: 'Acme Inc',
      jobtitle: ''
    });

    const prepared = await post('/api/crm/contact-upserts', { leadContactId: 'lead_fill' });
    expect(prepared.status).toBe(201);
    const { plan } = prepared.body.upsert;
    expect(plan.fields).toEqual({ title: 'VP Sales', phone: '+1 415 555 0100' });
    expect(plan.conflicts).toEqual([
      { field: 'firstName', crmValue: 'Janet', trevraValue: 'Jane' },
      { field: 'email', crmValue: 'j.doe@personal.test', trevraValue: 'jane@acme.com' },
      { field: 'company', crmValue: 'Acme Inc', trevraValue: 'Acme' }
    ]);
    expect(writeCalls()).toEqual([]);

    const approved = await approve(prepared.body.run.id);
    expect(approved.status).toBe(200);
    expect(approved.body.run.status).toBe('completed');
    expect(writeCalls()).toEqual([
      expect.objectContaining({
        method: 'PATCH',
        endpoint: '/crm/v3/objects/contacts/301',
        data: { properties: { jobtitle: 'VP Sales', phone: '+1 415 555 0100' } }
      })
    ]);
    expect(crm.state.hubspot.get('301')!.properties).toMatchObject({
      firstname: 'Janet',
      email: 'j.doe@personal.test',
      company: 'Acme Inc',
      jobtitle: 'VP Sales'
    });
    const row = await ledger('lead_fill');
    expect(row).toMatchObject({ status: 'succeeded', result_record_id: '301', attempts: 1 });
    const link = await db
      .prepare('SELECT * FROM crm_contact_links WHERE workspace_id=? AND lead_contact_id=?')
      .get<Record<string, unknown>>(WORKSPACE, 'lead_fill');
    expect(link).toMatchObject({
      provider: 'hubspot',
      connection_id: HUBSPOT,
      crm_record_id: '301',
      matched_by: 'linkedin_url'
    });
  });

  it('creates when nothing matches, then matches by the stored link first', async () => {
    await seedConnection('hubspot');
    await seedLead('lead_create', JANE);
    const prepared = await post('/api/crm/contact-upserts', { leadContactId: 'lead_create' });
    expect(prepared.body.upsert).toMatchObject({
      operation: 'create',
      matchTier: 'none',
      crmRecordId: null
    });
    expect(prepared.body.upsert.plan.fields).toEqual({
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane@acme.com',
      company: 'Acme',
      title: 'VP Sales',
      linkedinUrl: 'https://www.linkedin.com/in/jane-doe/',
      phone: '+1 415 555 0100'
    });

    const approved = await approve(prepared.body.run.id);
    expect(approved.body.run.status).toBe('completed');
    expect(crm.state.hubspot.size).toBe(1);
    const [created] = [...crm.state.hubspot.values()];
    expect(created!.properties).toMatchObject({
      firstname: 'Jane',
      email: 'jane@acme.com',
      hs_linkedin_url: 'https://www.linkedin.com/in/jane-doe/'
    });
    const link = await db
      .prepare('SELECT crm_record_id, matched_by FROM crm_contact_links WHERE workspace_id=?')
      .get<Record<string, unknown>>(WORKSPACE);
    expect(link).toEqual({ crm_record_id: created!.id, matched_by: 'created' });

    crm.state.calls.length = 0;
    const again = await post('/api/crm/contact-upserts', { leadContactId: 'lead_create' });
    expect(again.status).toBe(200);
    expect(again.body.run).toBeNull();
    expect(again.body.upsert).toMatchObject({
      status: 'up_to_date',
      matchTier: 'crm_link',
      crmRecordId: created!.id
    });
    // The stored id was read directly; no identity search ran.
    expect(crm.state.calls.map((call) => `${call.method} ${call.endpoint}`)).toEqual([
      `GET /crm/v3/objects/contacts/${created!.id}`
    ]);
  });

  it('refuses with stale_prepare when a planned field was filled after prepare', async () => {
    await seedConnection('hubspot');
    await seedLead('lead_stale', { ...JANE, phone: null });
    hubspotContact('401', { email: 'jane@acme.com', firstname: 'Jane', lastname: 'Doe' });
    const prepared = await post('/api/crm/contact-upserts', { leadContactId: 'lead_stale' });
    expect(Object.keys(prepared.body.upsert.plan.fields).sort()).toEqual([
      'company',
      'linkedinUrl',
      'title'
    ]);

    crm.state.hubspot.get('401')!.properties.jobtitle = 'CEO';
    const approved = await approve(prepared.body.run.id);
    expect(approved.body.run.status).toBe('failed');
    expect(approved.body.run.error).toContain('stale_prepare');
    expect(writeCalls()).toEqual([]);
    expect(crm.state.hubspot.get('401')!.properties.jobtitle).toBe('CEO');
    expect(await ledger('lead_stale')).toMatchObject({
      status: 'stale_prepare',
      error_code: 'stale_prepare'
    });
    // Terminal: the engine did not schedule a retry.
    expect(await actionAttempts(prepared.body.run.id)).toHaveLength(1);
  });

  it('refuses with stale_prepare when the record was merged or deleted', async () => {
    await seedConnection('hubspot');
    await seedLead('lead_merged', { ...JANE, phone: null });
    await seedLead('lead_deleted', {
      ...JANE,
      email: 'del@acme.com',
      profileUrl: null,
      phone: null
    });
    hubspotContact('501', { email: 'jane@acme.com' });
    hubspotContact('502', { email: 'del@acme.com' });
    const merged = await post('/api/crm/contact-upserts', { leadContactId: 'lead_merged' });
    const deleted = await post('/api/crm/contact-upserts', { leadContactId: 'lead_deleted' });

    hubspotContact('599', { email: 'jane@acme.com' });
    crm.state.hubspot.get('501')!.mergedInto = '599';
    crm.state.hubspot.delete('502');
    expect((await approve(merged.body.run.id)).body.run.status).toBe('failed');
    expect((await approve(deleted.body.run.id)).body.run.status).toBe('failed');
    expect((await ledger('lead_merged')).status).toBe('stale_prepare');
    expect((await ledger('lead_merged')).last_error).toContain('merged');
    expect((await ledger('lead_deleted')).status).toBe('stale_prepare');
    expect(writeCalls()).toEqual([]);
  });

  it('never creates twice: a lost response reconciles and a re-execute reuses the result', async () => {
    await seedConnection('hubspot');
    await seedLead('lead_idem', JANE);
    const prepared = await post('/api/crm/contact-upserts', { leadContactId: 'lead_idem' });
    // The create lands in the CRM, but the response never arrives.
    crm.state.failures.push({
      method: 'POST',
      endpoint: /^\/crm\/v3\/objects\/contacts$/,
      network: true,
      afterApply: true
    });
    const approved = await approve(prepared.body.run.id);
    expect(approved.body.run.status).toBe('queued');
    expect(crm.state.hubspot.size).toBe(1);
    const pending = await ledger('lead_idem');
    expect(pending).toMatchObject({ status: 'prepared', error_code: 'crm_unreachable' });
    expect(pending.write_attempted_at).not.toBeNull();

    const payload = pending.payload_json;
    const first = await executeCrmContactUpsert(db, {
      workspaceId: WORKSPACE,
      payload,
      payloadHash: pending.payload_hash
    });
    const [created] = [...crm.state.hubspot.values()];
    expect(first).toEqual({ provider: 'hubspot', externalRef: created!.id, reused: false });

    const second = await executeCrmContactUpsert(db, {
      workspaceId: WORKSPACE,
      payload,
      payloadHash: pending.payload_hash
    });
    expect(second).toEqual({ provider: 'hubspot', externalRef: created!.id, reused: true });
    expect(crm.state.hubspot.size).toBe(1);
    expect(writeCalls().filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(await ledger('lead_idem')).toMatchObject({
      status: 'succeeded',
      result_record_id: created!.id
    });
  });

  it('refuses a payload that differs from the prepared payload hash', async () => {
    await seedConnection('hubspot');
    await seedLead('lead_hash', JANE);
    await post('/api/crm/contact-upserts', { leadContactId: 'lead_hash' });
    const row = await ledger('lead_hash');
    const tampered = { ...row.payload_json, fields: { ...row.payload_json.fields, title: 'CEO' } };

    const sameHash = executeCrmContactUpsert(db, {
      workspaceId: WORKSPACE,
      payload: tampered,
      payloadHash: row.payload_hash
    });
    await expect(sameHash).rejects.toMatchObject({
      code: 'payload_hash_mismatch',
      retryable: false
    });

    const rehashed = executeCrmContactUpsert(db, {
      workspaceId: WORKSPACE,
      payload: tampered,
      payloadHash: canonicalPayloadHash(tampered)
    });
    await expect(rehashed).rejects.toMatchObject({ code: 'not_prepared', retryable: false });

    // A stored payload edited behind the hash is refused too.
    await db
      .prepare('UPDATE crm_contact_upserts SET payload_json=? WHERE id=?')
      .run(JSON.stringify(tampered), row.id);
    const stored = executeCrmContactUpsert(db, {
      workspaceId: WORKSPACE,
      payload: row.payload_json,
      payloadHash: row.payload_hash
    });
    await expect(stored).rejects.toMatchObject({ code: 'payload_hash_mismatch' });
    expect(writeCalls()).toEqual([]);
    expect((await ledger('lead_hash')).status).toBe('prepared');
  });

  it('retries a 429 and stops on a 400 with the error code recorded', async () => {
    await seedConnection('hubspot');
    await seedLead('lead_429', { ...JANE, phone: null });
    await seedLead('lead_400', { ...JANE, email: 'four@acme.com', profileUrl: null, phone: null });
    hubspotContact('601', { email: 'jane@acme.com' });
    hubspotContact('602', { email: 'four@acme.com' });
    const limited = await post('/api/crm/contact-upserts', { leadContactId: 'lead_429' });
    const invalid = await post('/api/crm/contact-upserts', { leadContactId: 'lead_400' });

    crm.state.failures.push({
      method: 'PATCH',
      endpoint: /\/601$/,
      status: 429,
      data: { category: 'RATE_LIMITS' }
    });
    const retried = await approve(limited.body.run.id);
    expect(retried.body.run.status).toBe('queued');
    const attempts = await actionAttempts(limited.body.run.id);
    expect(attempts.map((a) => [a.attempt, a.status])).toEqual([
      [1, 'failed'],
      [2, 'pending']
    ]);
    expect(attempts[0]!.error).toContain('crm_http_429');
    expect(await ledger('lead_429')).toMatchObject({
      status: 'prepared',
      error_code: 'crm_http_429:rate_limits'
    });

    crm.state.failures.push({
      method: 'PATCH',
      endpoint: /\/602$/,
      status: 400,
      data: { category: 'VALIDATION_ERROR', message: 'Property values were not valid: jane' }
    });
    const stopped = await approve(invalid.body.run.id);
    expect(stopped.body.run.status).toBe('failed');
    expect(await actionAttempts(invalid.body.run.id)).toHaveLength(1);
    const failed = await ledger('lead_400');
    expect(failed).toMatchObject({ status: 'failed', error_code: 'crm_http_400:validation_error' });
    // The provider's message (which can echo contact values) is not stored.
    expect(failed.last_error).not.toContain('jane');

    expect(isRetryableExecutionError(new CrmUpsertError('x', 'crm_http_429', 503, true))).toBe(
      true
    );
    expect(isRetryableExecutionError(new CrmUpsertError('x', 'crm_http_400', 422))).toBe(false);
    expect(isRetryableExecutionError(new Error('legacy'))).toBe(true);
  });
});

describe('crm.upsert-contact boundaries', () => {
  it('answers an explicit error for a missing, unsupported or unusable CRM', async () => {
    await seedLead('lead_unsupported', JANE);
    const none = await post('/api/crm/contact-upserts', { leadContactId: 'lead_unsupported' });
    expect(none.status).toBe(409);
    expect(none.body.code).toBe('crm_not_connected');

    const pipedrive = await seedConnection('pipedrive');
    const unsupported = await post('/api/crm/contact-upserts', {
      leadContactId: 'lead_unsupported',
      connectionId: pipedrive
    });
    expect(unsupported.status).toBe(422);
    expect(unsupported.body.code).toBe('crm_provider_unsupported');

    const demo = await seedConnection('hubspot', { id: 'con_crm_demo', demo: true });
    expect(
      (
        await post('/api/crm/contact-upserts', {
          leadContactId: 'lead_unsupported',
          connectionId: demo
        })
      ).body.code
    ).toBe('crm_provider_unsupported');

    const off = await seedConnection('attio', { id: 'con_crm_off', status: 'disconnected' });
    expect(
      (
        await post('/api/crm/contact-upserts', {
          leadContactId: 'lead_unsupported',
          connectionId: off
        })
      ).body.code
    ).toBe('crm_not_connected');

    await seedConnection('hubspot');
    await seedConnection('attio');
    const choose = await post('/api/crm/contact-upserts', { leadContactId: 'lead_unsupported' });
    expect(choose.status).toBe(400);
    expect(choose.body.code).toBe('crm_connection_required');
    expect(crm.state.calls).toEqual([]);
  });

  it('keeps leads, connections and prepared upserts inside their workspace', async () => {
    await seedConnection('hubspot');
    const otherConnection = await seedConnection('hubspot', { workspaceId: OTHER });
    await seedLead('lead_mine', JANE);
    await seedLead('lead_theirs', JANE, OTHER);

    const theirLead = await post('/api/crm/contact-upserts', { leadContactId: 'lead_theirs' });
    expect(theirLead.status).toBe(404);
    expect(theirLead.body.code).toBe('lead_not_found');
    const theirConnection = await post('/api/crm/contact-upserts', {
      leadContactId: 'lead_mine',
      connectionId: otherConnection
    });
    expect(theirConnection.status).toBe(404);
    expect(theirConnection.body.code).toBe('crm_connection_not_found');

    await post('/api/crm/contact-upserts', { leadContactId: 'lead_mine' });
    const row = await ledger('lead_mine');
    await expect(
      executeCrmContactUpsert(db, {
        workspaceId: OTHER,
        payload: row.payload_json,
        payloadHash: row.payload_hash
      })
    ).rejects.toMatchObject({ code: 'crm_connection_not_found' });
    const otherRows = await db
      .prepare('SELECT COUNT(*)::int AS n FROM crm_contact_upserts WHERE workspace_id=?')
      .get<{ n: number }>(OTHER);
    expect(otherRows!.n).toBe(0);
    expect(writeCalls()).toEqual([]);
  });

  it('caps bulk prepare at 100 leads', async () => {
    await seedConnection('hubspot');
    await seedLead('lead_bulk_a', JANE);
    await seedLead('lead_bulk_b', { ...JANE, email: 'b@acme.com', profileUrl: null });
    const ids = Array.from({ length: 98 }, (_, index) => `lead_missing_${index}`);

    const atCap = await post('/api/crm/contact-upserts/bulk', {
      leadContactIds: ['lead_bulk_a', 'lead_bulk_b', ...ids]
    });
    expect(atCap.status).toBe(200);
    expect(atCap.body.results).toHaveLength(100);
    expect(atCap.body.results[0]).toMatchObject({
      leadContactId: 'lead_bulk_a',
      created: true,
      error: null
    });
    expect(atCap.body.results[1]).toMatchObject({ leadContactId: 'lead_bulk_b', created: true });
    expect(atCap.body.results[99]).toMatchObject({
      upsert: null,
      error: { code: 'lead_not_found' }
    });

    crm.state.calls.length = 0;
    const overCap = await post('/api/crm/contact-upserts/bulk', {
      leadContactIds: ['lead_bulk_a', 'lead_bulk_b', ...ids, 'lead_101']
    });
    expect(overCap.status).toBe(400);
    expect(overCap.body).toMatchObject({ code: 'bulk_limit', max: 100 });
    expect(overCap.body.error).toContain('at most 100');
    expect(crm.state.calls).toEqual([]);
  });
});

describe('crm.upsert-contact on Attio', () => {
  it('creates a person through the field map, skipping the company reference and a non-E.164 phone', async () => {
    await seedConnection('attio');
    await seedLead('lead_ada', {
      firstName: 'Ada',
      lastName: 'Lovelace',
      company: 'Engine',
      email: 'ada@engine.test',
      phone: '415-555-0100',
      profileUrl: 'https://linkedin.com/in/ada-lovelace?trk=x'
    });
    const prepared = await post('/api/crm/contact-upserts', { leadContactId: 'lead_ada' });
    expect(prepared.status).toBe(201);
    expect(prepared.body.upsert.plan.fields).toEqual({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@engine.test',
      linkedinUrl: 'https://www.linkedin.com/in/ada-lovelace/'
    });
    expect(prepared.body.upsert.plan.skipped).toEqual([
      { field: 'company', reason: 'not_writable' },
      { field: 'phone', reason: 'phone_not_e164' }
    ]);

    expect((await approve(prepared.body.run.id)).body.run.status).toBe('completed');
    expect(writeCalls()).toEqual([
      expect.objectContaining({
        method: 'POST',
        endpoint: '/v2/objects/people/records',
        providerConfigKey: 'trevra-attio',
        data: {
          data: {
            values: {
              name: [{ first_name: 'Ada', last_name: 'Lovelace', full_name: 'Ada Lovelace' }],
              email_addresses: ['ada@engine.test'],
              linkedin: 'https://www.linkedin.com/in/ada-lovelace/'
            }
          }
        }
      })
    ]);
    const link = await db
      .prepare('SELECT connection_id, matched_by FROM crm_contact_links WHERE workspace_id=?')
      .get<Record<string, unknown>>(WORKSPACE);
    expect(link).toEqual({ connection_id: ATTIO, matched_by: 'created' });
  });

  it('matches by name + company through the company path and fills only empty attributes', async () => {
    await seedConnection('attio');
    await seedLead('lead_grace', {
      firstName: 'Grace',
      lastName: 'Hopper',
      company: 'Navy',
      phone: '+1 202 555 0199',
      title: 'Rear Admiral'
    });
    crm.state.attio.set('att_grace', {
      id: 'att_grace',
      companyName: 'Navy',
      values: {
        name: [{ first_name: 'Grace', last_name: 'Hopper', full_name: 'Grace Hopper' }],
        job_title: [{ value: 'Commodore' }]
      }
    });
    const prepared = await post('/api/crm/contact-upserts', { leadContactId: 'lead_grace' });
    expect(prepared.body.upsert).toMatchObject({
      matchTier: 'name_company',
      crmRecordId: 'att_grace',
      operation: 'update'
    });
    expect(prepared.body.upsert.plan.fields).toEqual({ phone: '+12025550199' });
    expect(prepared.body.upsert.plan.conflicts).toEqual([
      { field: 'title', crmValue: 'Commodore', trevraValue: 'Rear Admiral' }
    ]);

    expect((await approve(prepared.body.run.id)).body.run.status).toBe('completed');
    expect(writeCalls()).toEqual([
      expect.objectContaining({
        method: 'PATCH',
        endpoint: '/v2/objects/people/records/att_grace',
        data: { data: { values: { phone_numbers: [{ original_phone_number: '+12025550199' }] } } }
      })
    ]);
    expect(crm.state.attio.get('att_grace')!.values.job_title).toEqual([{ value: 'Commodore' }]);
  });
});
