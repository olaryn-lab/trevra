import { getNango } from '../integration-service.js';
import {
  CRM_CONTACT_FIELD_MAP,
  CRM_CONTACT_FIELDS,
  isCrmContactProvider,
  linkedinUrlVariants,
  normalizeEmail,
  normalizeLinkedinUrl,
  normalizeText,
  type CrmContactField,
  type CrmContactProviderKey
} from './contact-fields.js';

/**
 * CRM contact record reads and writes for `crm.upsert-contact` (TRV-051).
 *
 * Everything goes through the Nango proxy: Nango owns OAuth, token refresh and
 * the provider connection. Reads let Nango retry rate limits; writes do not,
 * because a retried mutation with an unknown first outcome is the execution
 * ledger's decision, not a transport's.
 *
 * Nothing here logs. Errors carry a status code and the provider's error
 * category, never a provider message, which can echo the values Trevra sent.
 */

export interface CrmHttpResponse {
  status: number;
  data: unknown;
}

export interface CrmHttp {
  request(
    method: 'GET' | 'POST' | 'PATCH',
    endpoint: string,
    init?: { params?: Record<string, string>; data?: unknown; read?: boolean }
  ): Promise<CrmHttpResponse>;
}

export class CrmUpsertError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    /** Read by the playbook engine: false means do not retry the action step. */
    readonly retryable = false
  ) {
    super(message);
    this.name = 'CrmUpsertError';
  }
}

export function staleError(reason: string): CrmUpsertError {
  return new CrmUpsertError(
    `stale_prepare: ${reason} Nothing was written; prepare the CRM sync again.`,
    'stale_prepare',
    409
  );
}

interface NangoProxyLike {
  proxy(config: Record<string, unknown>): Promise<{ status: number; data: unknown }>;
}

export function nangoCrmHttp(connection: {
  providerConfigKey: string;
  connectionId: string;
}): CrmHttp {
  let nango: NangoProxyLike;
  try {
    nango = getNango() as unknown as NangoProxyLike;
  } catch {
    throw new CrmUpsertError(
      'CRM access is not configured on this Trevra server (Nango).',
      'crm_not_configured',
      503
    );
  }
  return {
    async request(method, endpoint, init = {}) {
      try {
        const response = await nango.proxy({
          method,
          endpoint,
          providerConfigKey: connection.providerConfigKey,
          connectionId: connection.connectionId,
          ...(init.params ? { params: init.params } : {}),
          ...(init.data !== undefined ? { data: init.data } : {}),
          retries: init.read ? 2 : 0
        });
        return { status: response.status, data: response.data };
      } catch (error) {
        // axios underneath: a non-2xx rejects with the answer attached.
        const response = (error as { response?: { status?: unknown; data?: unknown } }).response;
        if (response && typeof response.status === 'number')
          return { status: response.status, data: response.data };
        throw new CrmUpsertError(
          'The CRM could not be reached; the outcome of this request is unknown.',
          'crm_unreachable',
          502,
          true
        );
      }
    }
  };
}

function ok(response: CrmHttpResponse): boolean {
  return response.status >= 200 && response.status < 300;
}

/** HubSpot `category`, Attio `code`, or Nango's `error.code`; safe characters only. */
function providerErrorCode(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  const nested =
    record.error && typeof record.error === 'object'
      ? (record.error as Record<string, unknown>).code
      : undefined;
  for (const candidate of [record.category, record.code, nested]) {
    if (typeof candidate === 'string' && /^[A-Za-z0-9_.-]{1,60}$/.test(candidate))
      return candidate.toLowerCase();
  }
  return null;
}

/** 429/5xx retry through the playbook engine; every other refusal is terminal. */
export function providerFailure(operation: string, response: CrmHttpResponse): CrmUpsertError {
  const detail = providerErrorCode(response.data);
  const code = `crm_http_${response.status}${detail ? `:${detail}` : ''}`;
  if (response.status === 429)
    return new CrmUpsertError(
      `The CRM rate-limited ${operation} (${code}); it will be retried.`,
      code,
      503,
      true
    );
  if (response.status >= 500)
    return new CrmUpsertError(
      `The CRM failed ${operation} (${code}); it will be retried.`,
      code,
      502,
      true
    );
  if (response.status === 401 || response.status === 403)
    return new CrmUpsertError(
      `The CRM refused ${operation} (${code}). Reconnect it with contact read and write access.`,
      code,
      409
    );
  return new CrmUpsertError(`The CRM rejected ${operation} (${code}).`, code, 422);
}

export interface CrmContactRecord {
  id: string;
  /** Raw values as the CRM holds them, keyed by Trevra field. Empty values omitted. */
  values: Partial<Record<CrmContactField, string>>;
  /** Every email on the record, normalized (Attio people hold several). */
  emails: string[];
  label: string | null;
}

export type CrmSearchTier = 'linkedin_url' | 'email' | 'name_company';
export const CRM_SEARCH_TIERS: readonly CrmSearchTier[] = ['linkedin_url', 'email', 'name_company'];

/** Email and LinkedIn URL normalized; names and company as display values. */
export interface CrmIdentity {
  linkedinUrl: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
}

export type CrmCreateResult =
  { kind: 'created'; id: string } | { kind: 'conflict'; existingId: string | null };

export interface CrmContactProvider {
  key: CrmContactProviderKey;
  name: string;
  /** False when the record's company is a reference matched inside the query. */
  readsCompanyText: boolean;
  /** Raw candidates for one tier; `searchTier` re-checks each one exactly. */
  search(tier: CrmSearchTier, identity: CrmIdentity, http: CrmHttp): Promise<CrmContactRecord[]>;
  /** Null when the record no longer exists. A merged record answers with another id. */
  get(recordId: string, http: CrmHttp): Promise<CrmContactRecord | null>;
  create(fields: Partial<Record<CrmContactField, string>>, http: CrmHttp): Promise<CrmCreateResult>;
  update(
    record: CrmContactRecord,
    fields: Partial<Record<CrmContactField, string>>,
    http: CrmHttp
  ): Promise<void>;
}

/** The normalized key a tier searches with, or null when Trevra has none. */
export function tierKey(tier: CrmSearchTier, identity: CrmIdentity): string | null {
  if (tier === 'linkedin_url') return identity.linkedinUrl;
  if (tier === 'email') return identity.email;
  const first = normalizeText(identity.firstName);
  const last = normalizeText(identity.lastName);
  const company = normalizeText(identity.company);
  return first && last && company ? `${first}|${last}|${company}` : null;
}

function tierMatches(
  provider: CrmContactProvider,
  tier: CrmSearchTier,
  identity: CrmIdentity,
  record: CrmContactRecord
): boolean {
  if (tier === 'linkedin_url')
    return normalizeLinkedinUrl(record.values.linkedinUrl) === identity.linkedinUrl;
  if (tier === 'email') return identity.email !== null && record.emails.includes(identity.email);
  return (
    normalizeText(record.values.firstName) === normalizeText(identity.firstName) &&
    normalizeText(record.values.lastName) === normalizeText(identity.lastName) &&
    (!provider.readsCompanyText ||
      normalizeText(record.values.company) === normalizeText(identity.company))
  );
}

/**
 * Exact matches for one tier, deduplicated by record id. The provider query is
 * only a candidate filter: every hit is re-checked against the normalized key,
 * so provider search semantics (tokenizing, case) cannot widen a match.
 */
export async function searchTier(
  provider: CrmContactProvider,
  tier: CrmSearchTier,
  identity: CrmIdentity,
  http: CrmHttp
): Promise<CrmContactRecord[]> {
  if (!tierKey(tier, identity)) return [];
  const seen = new Set<string>();
  const matches: CrmContactRecord[] = [];
  for (const record of await provider.search(tier, identity, http)) {
    if (seen.has(record.id) || !tierMatches(provider, tier, identity, record)) continue;
    seen.add(record.id);
    matches.push(record);
  }
  return matches;
}

/** Does the record still carry the key it was matched under? */
export function recordStillMatches(
  provider: CrmContactProvider,
  tier: CrmSearchTier,
  identity: CrmIdentity,
  record: CrmContactRecord
): boolean {
  return tierMatches(provider, tier, identity, record);
}

const SEARCH_LIMIT = 10;

/* ---------------------------------------------------------------- HubSpot */

const HUBSPOT = CRM_CONTACT_FIELD_MAP.hubspot;
const HUBSPOT_PROPERTIES = CRM_CONTACT_FIELDS.map((field) => HUBSPOT[field].property);

function hubspotRecord(raw: unknown): CrmContactRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as { id?: unknown; properties?: Record<string, unknown> };
  if (item.id === undefined || item.id === null || item.id === '') return null;
  const properties = item.properties ?? {};
  const values: Partial<Record<CrmContactField, string>> = {};
  for (const field of CRM_CONTACT_FIELDS) {
    const value = properties[HUBSPOT[field].property];
    if (typeof value === 'string' && value.trim()) values[field] = value;
  }
  const email = normalizeEmail(values.email);
  const label = [values.firstName, values.lastName].filter(Boolean).join(' ');
  return { id: String(item.id), values, emails: email ? [email] : [], label: label || null };
}

function hubspotProperties(
  fields: Partial<Record<CrmContactField, string>>
): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const [field, value] of Object.entries(fields) as Array<[CrmContactField, string]>) {
    properties[HUBSPOT[field].property] = value;
  }
  return properties;
}

/**
 * HubSpot CRM v3 contacts, current as of 2026-10-31:
 * - search:  POST /crm/v3/objects/contacts/search
 * - read:    GET /crm/v3/objects/contacts/{id}
 * - create:  POST /crm/v3/objects/contacts (409 CONFLICT on an existing email)
 * - update:  PATCH /crm/v3/objects/contacts/{id}
 * Scopes: `crm.objects.contacts.read` and `crm.objects.contacts.write`.
 */
export const hubspotContactProvider: CrmContactProvider = {
  key: 'hubspot',
  name: 'HubSpot',
  readsCompanyText: true,

  async search(tier, identity, http) {
    const filters =
      tier === 'linkedin_url'
        ? [
            {
              propertyName: HUBSPOT.linkedinUrl.property,
              operator: 'IN',
              values: linkedinUrlVariants(identity.linkedinUrl ?? '')
            }
          ]
        : tier === 'email'
          ? [{ propertyName: HUBSPOT.email.property, operator: 'EQ', value: identity.email }]
          : [
              {
                propertyName: HUBSPOT.firstName.property,
                operator: 'EQ',
                value: identity.firstName
              },
              { propertyName: HUBSPOT.lastName.property, operator: 'EQ', value: identity.lastName },
              { propertyName: HUBSPOT.company.property, operator: 'EQ', value: identity.company }
            ];
    const response = await http.request('POST', '/crm/v3/objects/contacts/search', {
      read: true,
      data: { filterGroups: [{ filters }], properties: HUBSPOT_PROPERTIES, limit: SEARCH_LIMIT }
    });
    if (!ok(response)) throw providerFailure('the contact search', response);
    const results = (response.data as { results?: unknown[] } | null)?.results ?? [];
    return results.map(hubspotRecord).filter((record): record is CrmContactRecord => !!record);
  },

  async get(recordId, http) {
    const response = await http.request(
      'GET',
      `/crm/v3/objects/contacts/${encodeURIComponent(recordId)}`,
      { read: true, params: { properties: HUBSPOT_PROPERTIES.join(','), archived: 'false' } }
    );
    if (response.status === 404) return null;
    if (!ok(response)) throw providerFailure('the contact read', response);
    return hubspotRecord(response.data);
  },

  async create(fields, http) {
    const response = await http.request('POST', '/crm/v3/objects/contacts', {
      data: { properties: hubspotProperties(fields) }
    });
    if (response.status === 409) {
      const message = (response.data as { message?: unknown } | null)?.message;
      const existing =
        typeof message === 'string' ? /Existing ID:\s*(\d+)/i.exec(message)?.[1] : undefined;
      return { kind: 'conflict', existingId: existing ?? null };
    }
    if (!ok(response)) throw providerFailure('the contact create', response);
    const id = (response.data as { id?: unknown } | null)?.id;
    if (id === undefined || id === null || id === '')
      throw new CrmUpsertError(
        'HubSpot accepted the contact but returned no id; the outcome is unknown.',
        'crm_no_id',
        502,
        true
      );
    return { kind: 'created', id: String(id) };
  },

  async update(record, fields, http) {
    const response = await http.request(
      'PATCH',
      `/crm/v3/objects/contacts/${encodeURIComponent(record.id)}`,
      { data: { properties: hubspotProperties(fields) } }
    );
    if (response.status === 404) throw staleError('The CRM record was deleted or merged.');
    if (!ok(response)) throw providerFailure('the contact update', response);
  }
};

/* ------------------------------------------------------------------ Attio */

const ATTIO = CRM_CONTACT_FIELD_MAP.attio;

function attioEntries(
  values: Record<string, unknown>,
  attribute: string
): Record<string, unknown>[] {
  const entries = values[attribute];
  return Array.isArray(entries)
    ? entries.filter(
        (entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object'
      )
    : [];
}

function attioString(entry: Record<string, unknown> | undefined, key: string): string | null {
  const value = entry?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function attioRecord(raw: unknown): CrmContactRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as { id?: { record_id?: unknown }; values?: Record<string, unknown> };
  const recordId = item.id?.record_id;
  if (typeof recordId !== 'string' || !recordId) return null;
  const source = item.values ?? {};
  const name = attioEntries(source, 'name')[0];
  const values: Partial<Record<CrmContactField, string>> = {};
  const assign = (field: CrmContactField, value: string | null) => {
    if (value) values[field] = value;
  };
  assign('firstName', attioString(name, 'first_name'));
  assign('lastName', attioString(name, 'last_name'));
  const emails = attioEntries(source, ATTIO.email.property)
    .map((entry) => attioString(entry, 'email_address'))
    .filter((value): value is string => !!value);
  assign('email', emails[0] ?? null);
  assign('title', attioString(attioEntries(source, ATTIO.title.property)[0], 'value'));
  assign('linkedinUrl', attioString(attioEntries(source, ATTIO.linkedinUrl.property)[0], 'value'));
  const phone = attioEntries(source, ATTIO.phone.property)[0];
  assign(
    'phone',
    attioString(phone, 'original_phone_number') ?? attioString(phone, 'phone_number')
  );
  const label =
    attioString(name, 'full_name') ??
    ([values.firstName, values.lastName].filter(Boolean).join(' ') || null);
  return {
    id: recordId,
    values,
    emails: emails
      .map((email) => normalizeEmail(email))
      .filter((email): email is string => !!email),
    label
  };
}

function attioValues(
  fields: Partial<Record<CrmContactField, string>>,
  existing: CrmContactRecord | null
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  if (fields.firstName !== undefined || fields.lastName !== undefined) {
    // One personal-name value holds both parts: keep the part already there.
    const first = fields.firstName ?? existing?.values.firstName ?? '';
    const last = fields.lastName ?? existing?.values.lastName ?? '';
    values.name = [{ first_name: first, last_name: last, full_name: `${first} ${last}`.trim() }];
  }
  if (fields.email !== undefined) values[ATTIO.email.property] = [fields.email];
  if (fields.title !== undefined) values[ATTIO.title.property] = fields.title;
  if (fields.linkedinUrl !== undefined) values[ATTIO.linkedinUrl.property] = fields.linkedinUrl;
  if (fields.phone !== undefined)
    values[ATTIO.phone.property] = [{ original_phone_number: fields.phone }];
  return values;
}

/**
 * Attio v2 people records, current as of 2026-10-31:
 * - query:   POST /v2/objects/people/records/query
 * - read:    GET /v2/objects/people/records/{record_id}
 * - create:  POST /v2/objects/people/records (email_addresses is unique)
 * - update:  PATCH /v2/objects/people/records/{record_id}
 * The person's `company` is a record reference, so the name + company tier
 * filters it through a path into `companies.name` and Trevra never writes it.
 * Scopes: `record_permission:read-write`, `object_configuration:read`.
 */
export const attioContactProvider: CrmContactProvider = {
  key: 'attio',
  name: 'Attio',
  readsCompanyText: false,

  async search(tier, identity, http) {
    const filter =
      tier === 'linkedin_url'
        ? {
            $or: linkedinUrlVariants(identity.linkedinUrl ?? '').map((value) => ({
              [ATTIO.linkedinUrl.property]: { $eq: value }
            }))
          }
        : tier === 'email'
          ? { [ATTIO.email.property]: { email_address: { $eq: identity.email } } }
          : {
              $and: [
                { name: { first_name: { $eq: identity.firstName } } },
                { name: { last_name: { $eq: identity.lastName } } },
                {
                  path: [
                    ['people', ATTIO.company.property],
                    ['companies', 'name']
                  ],
                  constraints: { value: identity.company }
                }
              ]
            };
    const response = await http.request('POST', '/v2/objects/people/records/query', {
      read: true,
      data: { filter, limit: SEARCH_LIMIT }
    });
    if (!ok(response)) throw providerFailure('the people query', response);
    const data = (response.data as { data?: unknown[] } | null)?.data ?? [];
    return data.map(attioRecord).filter((record): record is CrmContactRecord => !!record);
  },

  async get(recordId, http) {
    const response = await http.request(
      'GET',
      `/v2/objects/people/records/${encodeURIComponent(recordId)}`,
      { read: true }
    );
    if (response.status === 404) return null;
    if (!ok(response)) throw providerFailure('the person read', response);
    return attioRecord((response.data as { data?: unknown } | null)?.data);
  },

  async create(fields, http) {
    const response = await http.request('POST', '/v2/objects/people/records', {
      data: { data: { values: attioValues(fields, null) } }
    });
    if (
      response.status === 409 ||
      (response.status === 400 && providerErrorCode(response.data) === 'uniqueness_conflict')
    )
      return { kind: 'conflict', existingId: null };
    if (!ok(response)) throw providerFailure('the person create', response);
    const recordId = (response.data as { data?: { id?: { record_id?: unknown } } } | null)?.data?.id
      ?.record_id;
    if (typeof recordId !== 'string' || !recordId)
      throw new CrmUpsertError(
        'Attio accepted the person but returned no id; the outcome is unknown.',
        'crm_no_id',
        502,
        true
      );
    return { kind: 'created', id: recordId };
  },

  async update(record, fields, http) {
    const response = await http.request(
      'PATCH',
      `/v2/objects/people/records/${encodeURIComponent(record.id)}`,
      { data: { data: { values: attioValues(fields, record) } } }
    );
    if (response.status === 404) throw staleError('The CRM record was deleted or merged.');
    if (!ok(response)) throw providerFailure('the person update', response);
  }
};

const CONTACT_PROVIDERS: Record<CrmContactProviderKey, CrmContactProvider> = {
  hubspot: hubspotContactProvider,
  attio: attioContactProvider
};

/** The record adapter for a connection's provider, or an explicit unsupported error. */
export function contactProviderFor(provider: string): CrmContactProvider {
  if (!isCrmContactProvider(provider))
    throw new CrmUpsertError(
      `CRM contact sync is not supported for ${provider}. Supported: HubSpot, Attio.`,
      'crm_provider_unsupported',
      422
    );
  return CONTACT_PROVIDERS[provider];
}
