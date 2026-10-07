import type { Express } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auth as betterAuth, closeAuthDatabase, migrateAuthDatabase } from '../auth-service.js';
import { createApp } from '../app.js';
import { openDatabase, type Db } from '../db.js';
import {
  registerEmailComplianceProvider,
  resetEmailComplianceProvider
} from '../email/compliance.js';
import { senderComplianceProvider } from './provider.js';

let db: Db;
let app: Express;
let signUpSeq = 0;

async function signUp(label: string) {
  signUpSeq += 1;
  const agent = request.agent(app);
  const email = `${label}-${Date.now()}-${signUpSeq}@compliance-api.test`;
  const response = await agent
    .post('/api/auth/sign-up/email')
    .send({ email, password: 'correct-horse-battery-staple', name: label })
    .expect(200);
  const auth = (await agent.get('/api/auth/session').expect(200)).body.auth as {
    userId: string;
    workspaceId: string;
    role: 'owner' | 'member';
  };
  return { agent, userId: response.body.user.id as string, auth };
}

async function ownerAndMember() {
  const owner = await signUp('compliance-owner');
  const member = await signUp('compliance-member');
  await betterAuth.api.addMember({
    body: { userId: member.userId, organizationId: owner.auth.workspaceId, role: 'member' }
  });
  await member.agent
    .post('/api/auth/organization/set-active')
    .send({ organizationId: owner.auth.workspaceId })
    .expect(200);
  const memberAuth = (await member.agent.get('/api/auth/session').expect(200)).body.auth as {
    workspaceId: string;
    role: 'owner' | 'member';
  };
  expect(memberAuth.workspaceId).toBe(owner.auth.workspaceId);
  expect(memberAuth.role).toBe('member');
  return { owner, member };
}

beforeAll(async () => {
  await migrateAuthDatabase();
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  app = createApp(db);
});

// The real provider is registered at process entry, never by createApp.
beforeEach(() => registerEmailComplianceProvider(senderComplianceProvider));
afterEach(() => resetEmailComplianceProvider());

afterAll(async () => {
  await db?.close();
  await closeAuthDatabase();
});

describe('sender identity API', () => {
  it('lets every member read it, only the owner change it, and no other workspace see it', async () => {
    await request(app).get('/api/workspace/sender-identity').expect(401);
    const { owner, member } = await ownerAndMember();
    const outsider = await signUp('compliance-outsider');

    const empty = await member.agent.get('/api/workspace/sender-identity').expect(200);
    expect(empty.body.senderIdentity).toMatchObject({
      legalName: null,
      postalAddress: null,
      privacyPolicyUrl: null
    });
    await member.agent
      .put('/api/workspace/sender-identity')
      .send({ legalName: 'Member Ltd' })
      .expect(403);
    await owner.agent
      .put('/api/workspace/sender-identity')
      .send({ privacyPolicyUrl: 'http://compliance.example/privacy' })
      .expect(400);

    const saved = await owner.agent
      .put('/api/workspace/sender-identity')
      .send({
        legalName: 'Compliance Test GmbH',
        postalAddress: 'Bahnhofstrasse 1, 8001 Zurich',
        privacyPolicyUrl: 'https://compliance.example/privacy'
      })
      .expect(200);
    expect(saved.body.senderIdentity).toMatchObject({
      legalName: 'Compliance Test GmbH',
      postalAddress: 'Bahnhofstrasse 1, 8001 Zurich',
      privacyPolicyUrl: 'https://compliance.example/privacy'
    });
    const seen = await member.agent.get('/api/workspace/sender-identity').expect(200);
    expect(seen.body.senderIdentity.postalAddress).toBe('Bahnhofstrasse 1, 8001 Zurich');
    const other = await outsider.agent.get('/api/workspace/sender-identity').expect(200);
    expect(other.body.senderIdentity.postalAddress).toBeNull();

    // The saved identity is what the outreach footer is built from, per workspace.
    expect(await senderComplianceProvider.footer(db, owner.auth.workspaceId)).toContain(
      'Bahnhofstrasse 1, 8001 Zurich'
    );
    expect(await senderComplianceProvider.footer(db, outsider.auth.workspaceId)).toBeNull();
  });
});
