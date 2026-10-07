import type { Express } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const nangoMock = vi.hoisted(() => ({
  get: vi.fn(async (config: Record<string, unknown>) =>
    config.endpoint === '/gmail/v1/users/me/profile'
      ? { data: { emailAddress: 'Founder@Acme.test' }, headers: {} }
      : { data: {}, headers: {} }
  ),
  updateMetadata: vi.fn(async () => ({ data: {} })),
  startSync: vi.fn(async () => undefined),
  pauseSync: vi.fn(async () => undefined),
  syncStatus: vi.fn(async () => ({
    syncs: [{ status: 'SUCCESS', finishedAt: '2026-10-06T09:05:00.000Z' }]
  })),
  deleteConnection: vi.fn(async () => ({ data: undefined })),
  listRecords: vi.fn(async () => ({ records: [], next_cursor: null })),
  verifyIncomingWebhookRequest: vi.fn(() => true)
}));
vi.mock('@nangohq/node', () => ({
  Nango: class {
    get = nangoMock.get;
    updateMetadata = nangoMock.updateMetadata;
    startSync = nangoMock.startSync;
    pauseSync = nangoMock.pauseSync;
    syncStatus = nangoMock.syncStatus;
    deleteConnection = nangoMock.deleteConnection;
    listRecords = nangoMock.listRecords;
    verifyIncomingWebhookRequest = nangoMock.verifyIncomingWebhookRequest;
  }
}));

import { auth as betterAuth, closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { createApp } from '../app.js';
import { id, openDatabase, type Db } from '../db.js';
import { handleNangoWebhook } from '../integration-service.js';
import { getEmailChannelStatus, designateInboundMailbox } from './channel.js';
import type { DnsResolver } from './deliverability.js';

let db: Db;
let app: Express;
let signUpSeq = 0;

async function signUp(label: string) {
  signUpSeq += 1;
  const agent = request.agent(app);
  const email = `${label}-${Date.now()}-${signUpSeq}@email-channel.test`;
  const response = await agent
    .post('/api/auth/sign-up/email')
    .send({ email, password: 'correct-horse-battery-staple', name: label })
    .expect(200);
  const auth = (await agent.get('/api/auth/session').expect(200)).body.auth as {
    userId: string;
    workspaceId: string;
  };
  return { agent, userId: response.body.user.id as string, auth };
}

async function ownerWithMailbox() {
  const owner = await signUp('email-owner');
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO connections (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,created_at,updated_at)
       VALUES (?,?,'gmail','trevra-gmail',?,NULL,'connected',0,?,?)`
    )
    .run(
      `conn_${owner.auth.workspaceId}`,
      owner.auth.workspaceId,
      `gmail-${owner.auth.workspaceId}`,
      now,
      now
    );
  return {
    owner,
    connectionId: `conn_${owner.auth.workspaceId}`,
    external: `gmail-${owner.auth.workspaceId}`
  };
}

beforeAll(async () => {
  await migrateAuthDatabase();
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
});

beforeEach(() => {
  vi.stubEnv('NANGO_API_KEY', 'test-nango-key');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

afterAll(async () => {
  await db?.close();
  await closeAuthDatabase();
});

describe('email channel API', () => {
  it('shows mailboxes with their DNS state without touching real DNS', async () => {
    const { owner, connectionId } = await ownerWithMailbox();
    const response = await owner.agent.get('/api/email/channel').expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.channel.mailboxes).toEqual([
      expect.objectContaining({
        connectionId,
        providerKey: 'google',
        address: 'founder@acme.test',
        deliverability: expect.objectContaining({ domain: 'acme.test', status: 'unknown' })
      })
    ]);
    expect(response.body.channel.mailboxes[0].providerConfigKey).toBeUndefined();
    expect(response.body.channel.unsubscribe).toMatchObject({ oneClick: false, mailto: false });
    expect(response.body.channel.inbound).toBeNull();
  });

  it('lets only the owner choose the inbound mailbox and starts the Nango sync', async () => {
    const { owner, connectionId, external } = await ownerWithMailbox();
    const member = await signUp('email-member');
    await betterAuth.api.addMember({
      body: { userId: member.userId, organizationId: owner.auth.workspaceId, role: 'member' }
    });
    await member.agent
      .post('/api/auth/organization/set-active')
      .send({ organizationId: owner.auth.workspaceId })
      .expect(200);
    await member.agent.put('/api/email/inbound-mailbox').send({ connectionId }).expect(403);

    const response = await owner.agent
      .put('/api/email/inbound-mailbox')
      .send({ connectionId })
      .expect(200);
    expect(response.body.channel.inbound).toMatchObject({
      connectionId,
      address: 'founder@acme.test',
      syncStatus: 'syncing',
      syncError: null,
      nango: { status: 'SUCCESS', finishedAt: '2026-10-06T09:05:00.000Z' }
    });
    expect(nangoMock.updateMetadata).toHaveBeenCalledWith('trevra-gmail', external, {
      trevraInboundAddress: 'founder@acme.test'
    });
    expect(nangoMock.startSync).toHaveBeenCalledWith(
      'trevra-gmail',
      ['inbound-messages'],
      external
    );
  });

  it('records an unavailable sync instead of pretending it runs', async () => {
    const { owner, connectionId } = await ownerWithMailbox();
    nangoMock.startSync.mockRejectedValueOnce(new Error('Sync inbound-messages not found'));
    const response = await owner.agent
      .put('/api/email/inbound-mailbox')
      .send({ connectionId })
      .expect(200);
    expect(response.body.channel.inbound.syncStatus).toBe('unavailable');
    expect(response.body.channel.inbound.syncError).toContain('not found');
    expect(response.body.channel.unsubscribe.mailto).toBe(false);
  });

  it('stops reading the mailbox when cleared or disconnected', async () => {
    const { owner, connectionId, external } = await ownerWithMailbox();
    await owner.agent.put('/api/email/inbound-mailbox').send({ connectionId }).expect(200);
    const cleared = await owner.agent.delete('/api/email/inbound-mailbox').expect(200);
    expect(cleared.body.channel.inbound).toBeNull();
    expect(nangoMock.pauseSync).toHaveBeenCalledWith(
      'trevra-gmail',
      ['inbound-messages'],
      external
    );

    await owner.agent.put('/api/email/inbound-mailbox').send({ connectionId }).expect(200);
    await owner.agent.delete(`/api/integrations/${connectionId}`).expect(200);
    const row = await db
      .prepare('SELECT 1 AS present FROM email_inbound_mailboxes WHERE workspace_id=?')
      .get(owner.auth.workspaceId);
    expect(row).toBeUndefined();
  });

  it("refuses another workspace's connection", async () => {
    const { connectionId } = await ownerWithMailbox();
    const stranger = await signUp('email-stranger');
    await stranger.agent.put('/api/email/inbound-mailbox').send({ connectionId }).expect(404);
  });

  it('re-checks DNS on request', async () => {
    const { owner } = await ownerWithMailbox();
    const response = await owner.agent.post('/api/email/deliverability/recheck').expect(200);
    expect(response.body.channel.mailboxes[0].deliverability.status).toBe('unknown');
  });

  describe('inbound sync closer', () => {
    function syncEvent(external: string, success: boolean, syncName = 'inbound-messages') {
      return JSON.stringify({
        id: `nango_${id('evt')}`,
        type: 'sync',
        success,
        syncName,
        providerConfigKey: 'trevra-gmail',
        connectionId: external,
        model: 'InboundEmailMessage',
        error: success ? undefined : { message: 'secret stranger text' }
      });
    }
    async function inboundRow(workspaceId: string) {
      return db
        .prepare('SELECT sync_status,sync_error FROM email_inbound_mailboxes WHERE workspace_id=?')
        .get<{ sync_status: string; sync_error: string | null }>(workspaceId);
    }

    it('marks the designated mailbox unavailable on a failed sync and recovers on the next success', async () => {
      const { owner, connectionId, external } = await ownerWithMailbox();
      await owner.agent.put('/api/email/inbound-mailbox').send({ connectionId }).expect(200);
      await handleNangoWebhook(db, syncEvent(external, false), {});
      expect(await inboundRow(owner.auth.workspaceId)).toEqual({
        sync_status: 'unavailable',
        sync_error: 'Nango reported that the inbound-messages sync failed.'
      });
      await handleNangoWebhook(db, syncEvent(external, true), {});
      expect(await inboundRow(owner.auth.workspaceId)).toEqual({
        sync_status: 'syncing',
        sync_error: null
      });
    });

    it('ignores a failed inbound sync for a connection that is not designated', async () => {
      const { owner, connectionId } = await ownerWithMailbox();
      await owner.agent.put('/api/email/inbound-mailbox').send({ connectionId }).expect(200);
      const other = await ownerWithMailbox();
      await handleNangoWebhook(db, syncEvent(other.external, false), {});
      expect(await inboundRow(owner.auth.workspaceId)).toEqual({
        sync_status: 'syncing',
        sync_error: null
      });
      expect(await inboundRow(other.owner.auth.workspaceId)).toBeUndefined();
      // A different sync failing never touches the designation either.
      const { external } = await ownerWithMailbox();
      await handleNangoWebhook(db, syncEvent(external, false, 'something-else'), {});
    });

    it('persists unavailable when Nango reports an error state', async () => {
      const { owner, connectionId } = await ownerWithMailbox();
      await owner.agent.put('/api/email/inbound-mailbox').send({ connectionId }).expect(200);
      nangoMock.syncStatus.mockResolvedValueOnce({
        syncs: [{ status: 'ERROR', finishedAt: '2026-10-06T09:05:00.000Z' }]
      });
      const response = await owner.agent.get('/api/email/channel').expect(200);
      expect(response.body.channel.inbound).toMatchObject({
        syncStatus: 'unavailable',
        syncError: 'Nango reported that the inbound-messages sync failed.'
      });
      expect(await inboundRow(owner.auth.workspaceId)).toEqual({
        sync_status: 'unavailable',
        sync_error: 'Nango reported that the inbound-messages sync failed.'
      });
    });
  });

  it('refuses a stored address that is not one plain address, writing nothing', async () => {
    const { owner, connectionId } = await ownerWithMailbox();
    await db
      .prepare('UPDATE connections SET mailbox_address=? WHERE id=?')
      .run('lead@example.test\r\nBcc: x@evil.test', connectionId);
    const response = await owner.agent
      .put('/api/email/inbound-mailbox')
      .send({ connectionId })
      .expect(409);
    expect(response.body.error).toContain('could not read this mailbox address');
    await expect(
      designateInboundMailbox(db, {
        workspaceId: owner.auth.workspaceId,
        connectionId,
        actorUserId: owner.userId
      })
    ).rejects.toMatchObject({ status: 409 });
    const row = await db
      .prepare('SELECT 1 AS present FROM email_inbound_mailboxes WHERE workspace_id=?')
      .get(owner.auth.workspaceId);
    expect(row).toBeUndefined();
    expect(nangoMock.updateMetadata).not.toHaveBeenCalled();
  });

  it('answers within the deadline when DNS never responds', async () => {
    const { owner } = await ownerWithMailbox();
    const hanging: DnsResolver = { resolveTxt: () => new Promise<string[][]>(() => undefined) };
    const started = Date.now();
    const channel = await getEmailChannelStatus(db, owner.auth.workspaceId, {
      resolver: hanging,
      deadlineMs: 150
    });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(channel.mailboxes[0]!.deliverability).toMatchObject({
      domain: 'acme.test',
      status: 'unknown'
    });
  });
});
