import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { listDomainEvents } from '../control-plane/events.js';
import { createSuppression } from '../suppressions.js';
import { RECIPIENT_SQL } from '../email/outreach.js';
import {
  emailLawfulBasisAttributes,
  countLeadListMissingEmailBasis,
  evaluateEmailLawfulBasis,
  listLawfulBases,
  recordLawfulBasis,
  setAccountCountry,
  setContactCountry,
  withdrawLawfulBasis
} from './lawful-basis.js';

const WORKSPACE = 'ws_lawful_basis_test';
const OTHER = 'ws_lawful_basis_other';
const NOW = new Date('2026-08-21T09:00:00.000Z');
const LATER = new Date('2026-08-22T09:00:00.000Z');
const MAYA = 'con_lb_maya';
const EMAIL = 'maya@acme-gmbh.de';
let db: Db;

const evaluate = (workspaceId = WORKSPACE) =>
  evaluateEmailLawfulBasis(db, workspaceId, { email: EMAIL });

const consent = (workspaceId = WORKSPACE, sourceRef: string | null = 'signed-form') =>
  recordLawfulBasis(
    db,
    {
      workspaceId,
      personId: MAYA,
      channel: 'email',
      basis: 'consent',
      source: 'operator',
      sourceRef,
      actorUserId: null
    },
    NOW
  );

async function events(type: string) {
  return (await listDomainEvents(db, WORKSPACE, { streamType: 'contact', streamId: MAYA })).filter(
    (event) => event.eventType === type
  );
}

beforeEach(async () => {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  for (const workspaceId of [WORKSPACE, OTHER]) {
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(workspaceId, workspaceId, NOW.toISOString());
  }
  await db
    .prepare(
      `INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at)
       VALUES (?,?,'Maya',?,?,?,?)`
    )
    .run(MAYA, WORKSPACE, EMAIL, EMAIL, NOW.toISOString(), NOW.toISOString());
  await db
    .prepare(
      `INSERT INTO accounts (id,workspace_id,name,domain,created_at,updated_at)
       VALUES ('acc_lb_acme',?,'Acme GmbH','acme-gmbh.de',?,?)`
    )
    .run(WORKSPACE, NOW.toISOString(), NOW.toISOString());
  await db
    .prepare(
      `INSERT INTO account_contacts (id,workspace_id,account_id,contact_id,source,confidence,created_at,updated_at)
       VALUES ('acon_lb_acme',?,'acc_lb_acme',?,'test','explicit',?,?)`
    )
    .run(WORKSPACE, MAYA, NOW.toISOString(), NOW.toISOString());
});

afterEach(async () => {
  for (const workspaceId of [WORKSPACE, OTHER])
    await db?.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
  await db?.close();
});

describe('lawful basis for cold email', () => {
  it('derives Germany from the account domain and denies cold email without a basis', async () => {
    const decision = await evaluate();
    expect(decision).toMatchObject({
      status: 'missing',
      country: 'DE',
      countrySource: 'account_domain',
      basis: null
    });
    expect(decision.reason).not.toContain(EMAIL);
  });

  it('lets an explicit country override the account, and refuses one it cannot read', async () => {
    expect(
      await setContactCountry(
        db,
        { workspaceId: WORKSPACE, personId: MAYA, countryCode: 'United States', actorUserId: null },
        NOW
      )
    ).toEqual({ countryCode: 'US' });
    expect(await evaluate()).toMatchObject({ status: 'not_required', countrySource: 'contact' });

    await expect(
      setContactCountry(
        db,
        { workspaceId: WORKSPACE, personId: MAYA, countryCode: 'Atlantis', actorUserId: null },
        NOW
      )
    ).rejects.toMatchObject({ status: 400 });

    await setContactCountry(
      db,
      { workspaceId: WORKSPACE, personId: MAYA, countryCode: null, actorUserId: null },
      NOW
    );
    await setAccountCountry(
      db,
      { workspaceId: WORKSPACE, accountId: 'acc_lb_acme', countryCode: 'CH', actorUserId: null },
      NOW
    );
    expect(await evaluate()).toMatchObject({ country: 'CH', countrySource: 'account' });
  });

  it('records a basis once, with its source, and lets it cover cold email', async () => {
    const first = await consent();
    const second = await consent();
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.record.id).toBe(first.record.id);
    expect(first.record).toMatchObject({
      personId: MAYA,
      channel: 'email',
      basis: 'consent',
      source: 'operator',
      sourceRef: 'signed-form',
      recordedAt: NOW.toISOString(),
      withdrawnAt: null
    });
    const recorded = await events('lawful_basis.recorded');
    expect(recorded).toHaveLength(1);
    expect(JSON.stringify(recorded)).not.toContain(EMAIL);
    expect(await evaluate()).toMatchObject({ status: 'satisfied', basis: 'consent' });
  });

  it('blocks again once the consent is withdrawn', async () => {
    const { record } = await consent();
    const withdrawn = await withdrawLawfulBasis(
      db,
      { workspaceId: WORKSPACE, lawfulBasisId: record.id, actorUserId: null },
      LATER
    );
    expect(withdrawn.withdrawnAt).toBe(LATER.toISOString());
    await withdrawLawfulBasis(
      db,
      { workspaceId: WORKSPACE, lawfulBasisId: record.id, actorUserId: null },
      LATER
    );
    expect(await events('lawful_basis.withdrawn')).toHaveLength(1);
    expect(await evaluate()).toMatchObject({ status: 'missing', country: 'DE' });

    const again = await consent();
    expect(again.created).toBe(true);
    expect(await listLawfulBases(db, WORKSPACE, MAYA)).toHaveLength(2);
  });

  it('does not count a basis the country rule does not accept', async () => {
    await recordLawfulBasis(
      db,
      {
        workspaceId: WORKSPACE,
        personId: MAYA,
        channel: 'email',
        basis: 'legitimate_interest',
        source: 'operator',
        actorUserId: null
      },
      NOW
    );
    expect((await evaluate()).status).toBe('missing');
    await setContactCountry(
      db,
      { workspaceId: WORKSPACE, personId: MAYA, countryCode: 'FR', actorUserId: null },
      NOW
    );
    expect(await evaluate()).toMatchObject({ status: 'satisfied', basis: 'legitimate_interest' });
  });

  it('never reads or writes another workspace people', async () => {
    await consent();
    await expect(consent(OTHER)).rejects.toMatchObject({ status: 404 });
    await expect(
      withdrawLawfulBasis(
        db,
        {
          workspaceId: OTHER,
          lawfulBasisId: (await listLawfulBases(db, WORKSPACE, MAYA))[0]!.id,
          actorUserId: null
        },
        NOW
      )
    ).rejects.toMatchObject({ status: 404 });
    expect(await listLawfulBases(db, OTHER, MAYA)).toEqual([]);
    expect(await evaluate(OTHER)).toMatchObject({
      status: 'missing',
      country: null,
      countrySource: 'unknown'
    });
    expect(await evaluate()).toMatchObject({ status: 'satisfied' });
  });

  it('derives policy attributes from the payload recipients, never from fields the payload claims', async () => {
    expect(
      await emailLawfulBasisAttributes(db, WORKSPACE, {
        recipient: EMAIL,
        lawfulBasisStatus: 'covered',
        metadata: { deliveryPurpose: 'outreach' }
      })
    ).toMatchObject({ lawfulBasisStatus: 'missing', recipientsMissingBasis: 1 });
    expect(
      await emailLawfulBasisAttributes(db, WORKSPACE, { recipients: [EMAIL, 'lead@example.com'] })
    ).toMatchObject({ lawfulBasisStatus: 'missing', recipientsMissingBasis: 1 });
    expect(
      await emailLawfulBasisAttributes(db, WORKSPACE, { recipient: 'lead@example.com' })
    ).toMatchObject({ lawfulBasisStatus: 'covered', recipientsMissingBasis: 0 });
    expect(await emailLawfulBasisAttributes(db, WORKSPACE, { subject: 'No recipient' })).toEqual(
      {}
    );
  });
});

describe('lead-list country and recipients', () => {
  const LIST = 'lll_lb_list';
  const iso = NOW.toISOString();

  async function lead(
    id: string,
    input: {
      workspaceId?: string;
      email?: string | null;
      country?: string | null;
      personId?: string | null;
      doNotContact?: boolean;
      list?: boolean;
    }
  ) {
    const workspaceId = input.workspaceId ?? WORKSPACE;
    await db
      .prepare(
        `INSERT INTO linkedin_lead_contacts
           (id,workspace_id,list_id,first_name,last_name,company,email,country,person_id,do_not_contact,dedupe_key)
         VALUES (?,?,?,'Lee','Lead','Northwind',?,?,?,?,?)`
      )
      .run(
        id,
        workspaceId,
        LIST,
        input.email ?? null,
        input.country ?? null,
        input.personId ?? null,
        input.doNotContact ?? false,
        `dedupe_${id}`
      );
    if (input.list !== false)
      await db
        .prepare(
          'INSERT INTO linkedin_lead_list_members (workspace_id,list_id,contact_id,created_at) VALUES (?,?,?,?)'
        )
        .run(workspaceId, LIST, id, iso);
  }

  beforeEach(async () => {
    await db
      .prepare(
        'INSERT INTO linkedin_lead_lists (id,workspace_id,name,created_at,updated_at) VALUES (?,?,?,?,?)'
      )
      .run(LIST, WORKSPACE, 'Lawful basis list', iso, iso);
  });

  it('resolves a recipient whose only country is the lead-contact row through lead_list', async () => {
    await lead('llc_lb_only_country', { email: 'buyer@northwind.com', country: 'Germany' });
    const withContact = {
      recipient: 'buyer@northwind.com',
      metadata: { contactId: 'llc_lb_only_country' }
    };
    const found = await emailLawfulBasisAttributes(db, WORKSPACE, withContact);
    expect(found).toMatchObject({ lawfulBasisStatus: 'missing', recipientsMissingBasis: 1 });
    expect(found.lawfulBasisReason).toContain('recipient in DE');
    const decision = await evaluateEmailLawfulBasis(db, WORKSPACE, {
      email: 'buyer@northwind.com',
      leadCountry: 'Germany'
    });
    expect(decision).toMatchObject({ country: 'DE', countrySource: 'lead_list' });

    // No contactId, two recipients, or another workspace's contact: unknown country.
    for (const payload of [
      { recipient: 'buyer@northwind.com' },
      { recipients: ['buyer@northwind.com', 'b2@northwind.com'], metadata: withContact.metadata }
    ])
      expect(
        (await emailLawfulBasisAttributes(db, WORKSPACE, payload)).lawfulBasisReason
      ).toContain('unknown country');
    expect((await emailLawfulBasisAttributes(db, OTHER, withContact)).lawfulBasisReason).toContain(
      'unknown country'
    );

    await lead('llc_lb_us', { email: 'buyer@northwind.com', country: 'US' });
    expect(
      await emailLawfulBasisAttributes(db, WORKSPACE, {
        recipient: 'buyer@northwind.com',
        metadata: { contactId: 'llc_lb_us' }
      })
    ).toMatchObject({ lawfulBasisStatus: 'covered' });
  });

  it('counts only the people outreach would write to, by the person email first', async () => {
    await db
      .prepare(
        `INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at)
         VALUES ('con_lb_reserved',?,'Rae','rae@example.com','rae@example.com',?,?)`
      )
      .run(WORKSPACE, iso, iso);
    await db
      .prepare(
        `INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at)
         VALUES ('con_lb_counted',?,'Cal','cal@acme-gmbh.de','cal@acme-gmbh.de',?,?)`
      )
      .run(WORKSPACE, iso, iso);
    await db
      .prepare(
        `INSERT INTO contacts (id,workspace_id,name,created_at,updated_at)
         VALUES ('con_lb_bare',?,'Bo',?,?)`
      )
      .run(WORKSPACE, iso, iso);
    // Prepare skips a lead with no resolved Person and an address that is not an email.
    await lead('llc_lb_noperson', { email: 'noperson@acme-gmbh.de', country: 'DE' });
    await lead('llc_lb_badaddr', {
      email: 'not an address',
      country: 'DE',
      personId: 'con_lb_bare'
    });
    await lead('llc_lb_counted', {
      personId: 'con_lb_counted',
      email: 'one@acme-gmbh.de',
      country: 'DE'
    });
    await lead('llc_lb_dnc', { email: 'dnc@acme-gmbh.de', country: 'DE', doNotContact: true });
    await lead('llc_lb_suppressed', { email: 'Stop@acme-gmbh.de', country: 'DE' });
    await lead('llc_lb_noemail', { email: null, country: 'DE' });
    await lead('llc_lb_person', {
      email: 'lead-copy@acme-gmbh.de',
      country: 'DE',
      personId: 'con_lb_reserved'
    });
    await createSuppression(
      db,
      {
        workspaceId: WORKSPACE,
        channel: 'email',
        email: 'stop@acme-gmbh.de',
        reason: 'asked to stop',
        source: 'test'
      },
      NOW
    );
    // Prepare skips a Person already emailed (already_contacted), one with an
    // open outreach run (already_pending), and a repeat of an earlier address.
    for (const [personId, email] of [
      ['con_lb_contacted', 'contacted@acme-gmbh.de'],
      ['con_lb_pending', 'pending@acme-gmbh.de']
    ])
      await db
        .prepare(
          `INSERT INTO contacts (id,workspace_id,name,email,email_normalized,created_at,updated_at)
           VALUES (?,?,'Dee',?,?,?,?)`
        )
        .run(personId, WORKSPACE, email, email, iso, iso);
    await lead('llc_lb_contacted', {
      personId: 'con_lb_contacted',
      email: 'contacted@acme-gmbh.de',
      country: 'DE'
    });
    await db
      .prepare(
        `INSERT INTO gtm_deliveries
         (id,workspace_id,channel,connection_id,purpose,recipient,source_type,source_id,idempotency_key,status,started_at)
         VALUES ('gdel_lb_contacted',?,'email',NULL,'outreach','Contacted@acme-gmbh.de','email_action','gdel_lb_contacted','key-gdel_lb_contacted','sent',?::timestamptz)`
      )
      .run(WORKSPACE, iso);
    await lead('llc_lb_pending', {
      personId: 'con_lb_pending',
      email: 'pending@acme-gmbh.de',
      country: 'DE'
    });
    await db
      .prepare(
        `INSERT INTO playbook_runs
         (id,workspace_id,playbook_key,playbook_version,status,actor_type,actor_id,input_json,correlation_id)
         VALUES ('pbr_lb_pending',?,'gtm.email-outreach','1.0.0','waiting_approval','user',NULL,?::jsonb,'corr_lb_pending')`
      )
      .run(
        WORKSPACE,
        JSON.stringify({ idempotencyKey: 'eo_lb_pending', personId: 'con_lb_pending' })
      );
    await lead('llc_lb_repeat', {
      personId: 'con_lb_counted',
      email: 'one@acme-gmbh.de',
      country: 'DE'
    });
    // The person email (a reserved domain) wins over the lead copy, so that row needs no basis.
    expect(RECIPIENT_SQL).toContain('p.email');
    expect(await countLeadListMissingEmailBasis(db, WORKSPACE, LIST)).toEqual({
      checked: 2,
      missing: 1,
      truncated: false
    });
    expect(await countLeadListMissingEmailBasis(db, OTHER, LIST)).toEqual({
      checked: 0,
      missing: 0,
      truncated: false
    });
  });
});

describe('a payload cannot lend one person basis to another address', () => {
  const STRANGER = 'stranger@northwind-gmbh.de';
  const iso = NOW.toISOString();

  async function inboundEmailFrom(personId: string) {
    await db
      .prepare(
        `INSERT INTO conversations (id,workspace_id,person_id,last_activity_at,created_at,updated_at)
         VALUES ('cv_lb_1',?,?,?,?,?)`
      )
      .run(WORKSPACE, personId, iso, iso, iso);
    await db
      .prepare(
        `INSERT INTO conversation_messages
           (id,workspace_id,conversation_id,channel,provider,direction,body,source_type,source_id,occurred_at)
         VALUES ('cm_lb_1',?,'cv_lb_1','email','test','inbound','hello','test','src_1',?)`
      )
      .run(WORKSPACE, iso);
  }

  it('does not honour a personId whose email differs from the recipient', async () => {
    await inboundEmailFrom(MAYA);
    const foreign = await evaluateEmailLawfulBasis(db, WORKSPACE, {
      email: STRANGER,
      personId: MAYA,
      purpose: 'reply'
    });
    expect(foreign).toMatchObject({ status: 'missing', countrySource: 'unknown' });
    expect(
      await evaluateEmailLawfulBasis(db, WORKSPACE, {
        email: EMAIL,
        personId: MAYA,
        purpose: 'reply'
      })
    ).toMatchObject({ status: 'not_required' });

    await db.prepare('DELETE FROM conversations WHERE id=?').run('cv_lb_1');
    await recordLawfulBasis(
      db,
      {
        workspaceId: WORKSPACE,
        personId: MAYA,
        channel: 'email',
        basis: 'consent',
        source: 'operator',
        actorUserId: null
      },
      NOW
    );
    expect(
      await evaluateEmailLawfulBasis(db, WORKSPACE, { email: STRANGER, personId: MAYA })
    ).toMatchObject({ status: 'missing' });
    expect(
      await evaluateEmailLawfulBasis(db, WORKSPACE, { email: EMAIL, personId: MAYA })
    ).toMatchObject({ status: 'satisfied', basis: 'consent' });
  });

  it('honours a personId bound through that person lead-contact email', async () => {
    await recordLawfulBasis(
      db,
      {
        workspaceId: WORKSPACE,
        personId: MAYA,
        channel: 'email',
        basis: 'consent',
        source: 'operator',
        actorUserId: null
      },
      NOW
    );
    await db
      .prepare(
        'INSERT INTO linkedin_lead_lists (id,workspace_id,name,created_at,updated_at) VALUES (?,?,?,?,?)'
      )
      .run('lll_lb_bind', WORKSPACE, 'Bind', iso, iso);
    await db
      .prepare(
        `INSERT INTO linkedin_lead_contacts
           (id,workspace_id,list_id,first_name,last_name,company,email,person_id,dedupe_key)
         VALUES ('llc_lb_bind',?,'lll_lb_bind','Maya','M','Acme',?,?,'dedupe_bind')`
      )
      .run(WORKSPACE, 'maya.work@acme-gmbh.de', MAYA);
    expect(
      await evaluateEmailLawfulBasis(db, WORKSPACE, {
        email: 'maya.work@acme-gmbh.de',
        personId: MAYA
      })
    ).toMatchObject({ status: 'satisfied', basis: 'consent' });
  });

  it('reads a lead-contact country only for that recipient, and evaluates every payload key', async () => {
    await db
      .prepare(
        'INSERT INTO linkedin_lead_lists (id,workspace_id,name,created_at,updated_at) VALUES (?,?,?,?,?)'
      )
      .run('lll_lb_c2', WORKSPACE, 'C2', iso, iso);
    await db
      .prepare(
        `INSERT INTO linkedin_lead_contacts
           (id,workspace_id,list_id,first_name,last_name,company,email,country,dedupe_key)
         VALUES ('llc_lb_us_other',?,'lll_lb_c2','Us','Lead','Other','someone@other.com','US','dedupe_us')`
      )
      .run(WORKSPACE);
    const attrs = await emailLawfulBasisAttributes(db, WORKSPACE, {
      recipient: 'buyer@northwind-gmbh.de',
      metadata: { contactId: 'llc_lb_us_other' }
    });
    expect(attrs).toMatchObject({ lawfulBasisStatus: 'missing', recipientsMissingBasis: 1 });
    expect(attrs.lawfulBasisReason).toContain('unknown country');

    // execution.ts sends to payload.recipient, so that address must be evaluated.
    expect(
      await emailLawfulBasisAttributes(db, WORKSPACE, {
        recipients: ['lead@example.com'],
        recipient: 'buyer@northwind-gmbh.de'
      })
    ).toMatchObject({ lawfulBasisStatus: 'missing', recipientsMissingBasis: 1 });
    expect(
      await emailLawfulBasisAttributes(db, WORKSPACE, {
        recipients: [],
        recipient: 'buyer@northwind-gmbh.de'
      })
    ).toMatchObject({ lawfulBasisStatus: 'missing' });
  });
});
