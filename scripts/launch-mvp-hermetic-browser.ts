/**
 * Hermetic L1 first-user browser acceptance.
 * Launches ONLY an ephemeral localhost test listener and a disposable PostgreSQL
 * container. No existing services, provider accounts or runtime databases touched.
 *
 *   npx tsx scripts/launch-mvp-hermetic-browser.ts
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createServer as createTcpServer } from 'node:net';
import { once } from 'node:events';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { createServer as createViteServer } from 'vite';
import type { Server } from 'node:http';

const assertions: Array<{ check: string; pass: boolean; detail?: string }> = [];
function check(check: string, pass: boolean, detail?: string) {
  assertions.push({ check, pass, ...(detail ? { detail } : {}) });
  if (!pass) throw new Error('Launch acceptance failed: ' + check + (detail ? ' — ' + detail : ''));
}

async function runDocker(args: string[]): Promise<string> {
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '',
    err = '';
  child.stdout.on('data', (chunk) => {
    out += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    err += String(chunk);
  });
  const [code] = (await once(child, 'close')) as [number];
  if (code !== 0) throw new Error('docker ' + args[0] + ' failed: ' + err.slice(0, 180));
  return out.trim();
}

async function chooseLocalPort(): Promise<number> {
  const server = createTcpServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  server.close();
  await once(server, 'close');
  return port;
}

async function main() {
  // Force a non-hosted environment; this test must not inherit live credentials.
  for (const key of Object.keys(process.env)) {
    if (
      /^(NANGO_|AUTHWARD_|BILLING_|SMTP_|OPENAI_|STRIPE_|TREVRA_BROWSER_|TREVRA_COMPANION_|TREVRA_LINKEDIN_)/.test(
        key
      )
    ) {
      delete process.env[key];
    }
  }
  const port = await chooseLocalPort();
  const origin = 'http://127.0.0.1:' + port;
  process.env.NODE_ENV = 'test';
  process.env.TREVRA_DEPLOYMENT_MODE = 'local';
  process.env.APP_ORIGIN = origin;
  process.env.BETTER_AUTH_URL = origin;
  process.env.BETTER_AUTH_SECRET = 'mvp-test-only-isolated-auth-secret-more-than-32-characters';
  process.env.COOKIE_SECURE = 'false';
  process.env.ALLOW_DEMO_AUTH = 'false';
  process.env.ALLOW_SIMULATED_EXECUTION = 'false';
  process.env.TREVRA_DNS_DISABLED = 'true';
  process.env.TREVRA_SECRETS_KEY = Buffer.alloc(32, 33).toString('base64');
  process.env.PUBLIC_SITE_URL = origin;
  let containerId: string | undefined;
  let listener: Server | undefined;
  let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let traceContext: BrowserContext | undefined;
  let evidencePage: Page | undefined;
  let db: Awaited<ReturnType<typeof import('../src/server/db.js').openDatabase>> | undefined;
  let closeAuthDb: (() => Promise<void>) | undefined;
  try {
    const name = 'trevra-mvp-browser-' + process.pid;
    containerId = await runDocker([
      'run',
      '--detach',
      '--rm',
      '--name',
      name,
      '--env',
      'POSTGRES_DB=trevra_test',
      '--env',
      'POSTGRES_USER=trevra',
      '--env',
      'POSTGRES_PASSWORD=trevra-test-password',
      '--publish',
      '127.0.0.1::5432',
      'postgres:17-alpine'
    ]);
    let dbPort = '';
    for (let retry = 0; retry < 90; retry++) {
      try {
        await runDocker([
          'exec',
          containerId,
          'pg_isready',
          '-h',
          '127.0.0.1',
          '-U',
          'trevra',
          '-d',
          'trevra_test'
        ]);
        dbPort = (await runDocker(['port', containerId, '5432/tcp'])).match(/:(\d+)$/)?.[1] ?? '';
        if (dbPort) break;
      } catch {
        /* next attempt */
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!dbPort) throw new Error('Disposable PostgreSQL unavailable');
    const dbUrl = 'postgresql://trevra:trevra-test-password@127.0.0.1:' + dbPort + '/trevra_test';
    process.env.DATABASE_URL = dbUrl;
    process.env.TEST_DATABASE_URL = dbUrl;
    const { openDatabase } = await import('../src/server/db.js');
    const authModule = await import('../src/server/auth-service.js');
    const { createApp } = await import('../src/server/app.js');
    closeAuthDb = authModule.closeAuthDatabase;
    db = await openDatabase({ connectionString: dbUrl, seedDemo: false });
    await authModule.migrateAuthDatabase();
    const app = createApp(db);
    // Restrict Vite's dependency discovery to the actual React entrypoint.
    // Its default glob over every HTML file includes historical spike fixture
    // documents importing nonexistent @dna/* packages. That optimizer failure
    // intermittently breaks real browser loads unrelated to our product.
    // Vite serves the ACTUAL React app through this isolated listener.
    // It has no API proxy and routes API calls to the above Express app.
    vite = await createViteServer({
      configFile: false,
      root: process.cwd(),
      appType: 'spa',
      plugins: [(await import('@vitejs/plugin-react')).default()],
      optimizeDeps: { entries: ['src/client/main.tsx'] },
      server: { middlewareMode: true, hmr: false }
    });
    app.use(vite.middlewares);
    listener = app.listen(port, '127.0.0.1');
    await once(listener, 'listening');
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const ctx = await browser.newContext();
    traceContext = ctx;
    if (process.env.LAUNCH_ACCEPTANCE_REPORT_DIR) {
      await ctx.tracing.start({ screenshots: true, snapshots: true, sources: false });
    }
    const page = await ctx.newPage();
    evidencePage = page;
    /**
     * Cold app module initialization occasionally fails before any operator
     * action has been taken. A bounded read-only reload is safe while looking
     * for a prerequisite button. Do NOT repeat mutations or authorization
     * POSTs after a timeout.
     */
    const prerequisite = async (targetPage: Page, buttonName: string | RegExp, timeout = 18000) => {
      const locator = targetPage.getByRole('button', { name: buttonName });
      try {
        await locator.waitFor({ timeout });
      } catch {
        await targetPage.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
        try {
          await locator.waitFor({ timeout });
        } catch (error) {
          throw new Error(
            'UI prerequisite ' +
              String(buttonName) +
              ' unavailable after bounded reload at ' +
              new URL(targetPage.url()).pathname +
              ': ' +
              (error instanceof Error ? error.message : String(error))
          );
        }
      }
      return locator;
    };
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message.slice(0, 200)));
    const first = await page.goto(origin + '/login', {
      waitUntil: 'domcontentloaded',
      timeout: 20000
    });
    check('L1 local app shell loads', first?.status() === 200);
    await prerequisite(page, 'Create an account');
    check('L1 real unauthenticated auth view shown', true);
    await page.getByRole('button', { name: 'Create an account' }).click();
    const email = 'isolated-first-user-' + Date.now() + '@example.test';
    await page.getByPlaceholder('Alex Morgan').fill('First Operator');
    await page.getByPlaceholder('you@company.com').fill(email);
    await page
      .getByPlaceholder('At least 10 characters')
      .fill('test-only-an-example-password-2026');
    const signUp = page.waitForResponse((r) => r.url().includes('/api/auth/sign-up/email'), {
      timeout: 30000
    });
    await page.getByRole('button', { name: 'Create workspace' }).click();
    const res = await signUp;
    check('L1 local browser registration succeeds', res.status() === 200, 'status=' + res.status());
    const sessionRes = await page.request.get(origin + '/api/auth/session');
    const sessionBody = await sessionRes.json();

    check(
      'L1 owner workspace session created',
      sessionRes.status() === 200 &&
        !!sessionBody.auth?.workspaceId &&
        sessionBody.auth?.role === 'owner',
      'status=' + sessionRes.status()
    );
    // Wait for actual authenticated navigation; a hidden signup button alone
    // could also mean the React app failed or rendered in-place at /login.
    await page.waitForURL('**/loop', { timeout: 18000 });
    await page.locator('.app-shell').waitFor({ timeout: 18000 });
    check(
      'L1 page leaves login after signup',
      new URL(page.url()).pathname === '/loop' &&
        (await page.getByRole('link', { name: 'Outreach' }).count()) > 0,
      'url=' + page.url()
    );
    console.log('L1 workspace created and readback, id omitted');
    // L5: exercise ACTUAL authenticated React screens, not a mocked UI.
    await page.goto(origin + '/outreach', { waitUntil: 'domcontentloaded' });
    await prerequisite(page, /New campaign/i);
    check('L5 authenticated campaigns screen renders and permits navigation', true);
    // UI-shell layout verification at desktop and mobile. Never infer visual
    // parity from static CSS alone: sample real computed styles in Chromium.
    const desktopShell = await page.evaluate(() => {
      const shell = document.querySelector('.app-shell');
      const aside = document.querySelector('.sidebar');
      const main = document.querySelector('.main');
      const topbar = document.querySelector('.topbar');
      return {
        tracks: shell ? getComputedStyle(shell).gridTemplateColumns : '',
        asideWidth: aside?.getBoundingClientRect().width ?? 0,
        mainPadding: main ? getComputedStyle(main).paddingLeft : '',
        topbarHeight: topbar?.getBoundingClientRect().height ?? 0,
        navGap: aside?.querySelector('nav') ? getComputedStyle(aside.querySelector('nav')!).gap : ''
      };
    });
    check(
      'UI desktop shell keeps compact sidebar and zero-min-width content track',
      Math.abs(desktopShell.asideWidth - 228) <= 1 &&
        desktopShell.mainPadding === '32px' &&
        desktopShell.navGap === '2px' &&
        desktopShell.topbarHeight >= 64
    );
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileShell = await page.evaluate(() => {
      const shell = document.querySelector('.app-shell');
      const aside = document.querySelector('.sidebar');
      const main = document.querySelector('.main');
      const tabs = document.querySelector('.mobile-tabbar');
      const topbar = document.querySelector('.topbar');
      return {
        tracks: shell ? getComputedStyle(shell).gridTemplateColumns : '',
        sidebar: aside ? getComputedStyle(aside).display : '',
        mainPadding: main ? getComputedStyle(main).paddingLeft : '',
        bottomPadding: main ? parseFloat(getComputedStyle(main).paddingBottom) : 0,
        tabs: tabs ? getComputedStyle(tabs).display : '',
        headerPadding: topbar ? getComputedStyle(topbar).paddingTop : ''
      };
    });
    check(
      'UI mobile shell keeps content, navigation and safe-area spacing',
      mobileShell.sidebar === 'none' &&
        mobileShell.tabs === 'grid' &&
        mobileShell.mainPadding === '16px' &&
        mobileShell.bottomPadding >= 74 &&
        mobileShell.headerPadding === '18px'
    );
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.getByRole('button', { name: /New campaign/i }).click();
    await page.getByRole('heading', { name: 'One thing is missing' }).waitFor({ timeout: 25000 });
    check('L5 missing LinkedIn sender blocks new campaign with actionable explanation', true);
    await page.getByRole('button', { name: /Connect account in Setup/i }).click();
    await page.waitForURL(/\/setup\/workspace$/, { timeout: 12000 });
    check('L5 configuration CTA reaches actual workspace setup', true);
    // Provider DOUBLE: only a workspace seat record inside the disposable DB;
    // no Companion, LinkedIn session or network connection is created.
    const { upsertSeat } = await import('../src/server/linkedin/seats.js');
    await upsertSeat(
      db,
      sessionBody.auth.workspaceId,
      {
        label: 'Isolated test sender (NOT paired)',
        timezone: 'UTC',
        workingDays: [0, 1, 2, 3, 4, 5, 6],
        workStartMinute: 0,
        workEndMinute: 1440
      },
      new Date()
    );

    await page.goto(origin + '/outreach/new', { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Prepare outreach' }).waitFor({ timeout: 25000 });
    check('L5 provider-double seat exposes real CSV preparation UI', true);
    const csv = [
      'First Name,Last Name,Company,Email,LinkedIn URL',
      'Maya,Chen,Acme,MAYA@EXAMPLE.COM,https://linkedin.com/in/mvp-l5-maya/',
      'Maya,Chen,Acme,maya@example.com,https://linkedin.com/in/mvp-l5-maya/',
      'Jon,Lee,Beta,jon@example.com,https://linkedin.com/in/mvp-l5-jon/'
    ].join('\n');
    await page.locator('input[type=file]').setInputFiles({
      name: 'first-customer.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv)
    });
    await page.getByRole('button', { name: /Prepare campaign/i }).click();
    const campaignNavigation = page.waitForURL(/\/outreach\/campaign\//, { timeout: 20000 });
    await campaignNavigation;
    check('L5 CSV creates a draft through real browser', true);
    const campaignId = page.url().split('/').pop() ?? '';
    const campaignResponse = await page.request.get(
      origin + '/api/linkedin/manager/campaigns/' + encodeURIComponent(campaignId)
    );
    const campaignBody = await campaignResponse.json();
    check(
      'L5 draft campaign persists and cannot send before start',
      campaignResponse.status() === 200 && campaignBody.campaign?.status === 'draft'
    );
    const members = campaignBody.members ?? [];
    check(
      'L5 CSV duplicate collapses to two campaign members',
      members.length === 2,
      'memberCount=' + members.length
    );

    // No automation worker or provider is started. These controls mutate
    // only this disposable tenant's PostgreSQL records.
    await (await prerequisite(page, /^Start$/)).click();
    await page.getByRole('button', { name: 'Start this campaign' }).waitFor();
    check('L5 start displays confirmation before running', true);
    await page.getByRole('button', { name: 'Start this campaign' }).click();
    await page.getByRole('button', { name: /^Pause$/ }).waitFor({ timeout: 18000 });
    const campaignStatus = async () => {
      const response = await page.request.get(
        origin + '/api/linkedin/manager/campaigns/' + encodeURIComponent(campaignId)
      );
      return (await response.json()).campaign?.status;
    };
    check('L5 start status persisted', (await campaignStatus()) === 'running');
    await page.getByRole('button', { name: /^Pause$/ }).click();
    await page.getByRole('button', { name: /^Resume$/ }).waitFor({ timeout: 18000 });
    check('L5 pause status persisted', (await campaignStatus()) === 'paused');
    await page.getByRole('button', { name: /^Resume$/ }).click();
    await page.getByRole('button', { name: 'Resume this campaign' }).waitFor();
    await page.getByRole('button', { name: 'Resume this campaign' }).click();
    await page.getByRole('button', { name: /^Pause$/ }).waitFor({ timeout: 18000 });
    check('L5 resume status persisted', (await campaignStatus()) === 'running');
    await page.getByRole('button', { name: /^Stop$/ }).click();
    await page.getByRole('button', { name: 'Stop this campaign' }).waitFor();
    await page.getByRole('button', { name: 'Stop this campaign' }).click();
    await page.waitForTimeout(500);
    check('L5 stop status persisted', (await campaignStatus()) === 'stopped');

    // L5/L6: Build a second campaign with the REAL tenant-scoped API, using
    // an explicit invite workflow so the planner creates deterministic exact
    // action approvals. We exercise review and dispatch through the real UI.
    const postJson = async (path: string, data: object) => {
      const response = await page.request.post(origin + path, { data });
      if (response.status() < 200 || response.status() >= 300) {
        throw new Error('Isolated API fixture failed: ' + path + ' HTTP ' + response.status());
      }
      try {
        return await response.json();
      } catch {
        throw new Error('Fixture returned non-JSON: ' + path + ' HTTP ' + response.status());
      }
    };
    const list = (
      await postJson('/api/linkedin/manager/lead-lists', {
        name: 'Owned test lead list',
        sourceKind: 'csv'
      })
    ).list;
    const importResponse = await page.request.post(
      origin + '/api/linkedin/manager/lead-lists/' + list.id + '/import',
      {
        multipart: {
          file: { name: 'owned-people.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) }
        }
      }
    );
    check(
      'L5 approval workflow fixture imports only synthetic CSV',
      importResponse.status() === 201
    );
    const workflow = (
      await postJson('/api/linkedin/manager/workflows', {
        name: 'Test-only personalized invite',
        steps: [
          {
            id: 'invite',
            action: 'connection_request',
            delayBefore: { amount: 0, unit: 'hours' },
            config: { message: 'Hello {{first_name}} at {{company}}' }
          }
        ]
      })
    ).workflow;

    const reviewCampaign = (
      await postJson('/api/linkedin/manager/campaigns', {
        name: 'Review acceptance (never live)',
        leadListId: list.id,
        workflowId: workflow.id,
        senderKeys: ['owner']
      })
    ).campaign;

    await page.goto(origin + '/outreach/campaign/' + reviewCampaign.id, {
      waitUntil: 'domcontentloaded'
    });
    await (await prerequisite(page, /^Start$/)).click();
    await page.getByRole('button', { name: 'Start this campaign' }).click();
    await page.getByRole('button', { name: /^Pause$/ }).waitFor({ timeout: 20000 });
    // Keep the Outreach screen open while a background worker plans actions.
    // The review queue must refresh without navigation or an unsafe replay.
    await page.goto(origin + '/outreach', { waitUntil: 'domcontentloaded' });
    await prerequisite(page, /New campaign/i);

    const now = new Date();
    const { runManagedCampaigns } = await import('../src/server/linkedin/runner.js');
    await runManagedCampaigns(
      db,
      sessionBody.auth.workspaceId,
      new Date(now.getTime() + 2 * 3600000)
    );

    const reviewUrl = origin + '/api/linkedin/manager/action-approvals';
    const reviewResponse = await page.request.get(reviewUrl);

    check(
      'L5 review API is reachable within rate limits',
      reviewResponse.status() === 200,
      'status=' + reviewResponse.status()
    );
    check(
      'L6 authenticated traffic uses the per-workspace rate bucket',
      (reviewResponse.headers()['ratelimit-policy'] ?? '').startsWith('1200;')
    );
    const reviews = (await reviewResponse.json()).reviews ?? [];
    check(
      'L5 planner creates real tenant-scoped personalized approvals',
      reviewResponse.status() === 200 && reviews.length > 0,
      'pendingCount=' + reviews.length
    );
    check(
      'L5 preview interpolates actual recipient tokens',
      reviews.some((review: { body?: string }) =>
        /Hello (Maya|Jon) at (Acme|Beta)/.test(review.body ?? '')
      )
    );
    const tampered = await page.request.post(reviewUrl + '/' + reviews[0].actionId, {
      data: { contentHash: '0'.repeat(64) }
    });
    check('L6 altered message content hash is rejected', tampered.status() === 409);
    const { postgresLocalWorkerStore, runLinkedInLocalBatch } =
      await import('../src/server/linkedin/local-worker.js');
    const { linkedinActionPolicyGate } = await import('../src/server/linkedin/action-policy.js');
    let driverCalls = 0;
    const runSafeWorker = async () =>
      runLinkedInLocalBatch(postgresLocalWorkerStore(db!, sessionBody.auth.workspaceId, 'owner'), {
        driver: {
          sendInvite: async () => {
            driverCalls++;
            return { ok: true, externalRef: 'test-only-' + driverCalls, failureKind: null };
          }
        } as any,
        page: {} as any,
        now: () => new Date(now.getTime() + 3 * 3600000),
        sleep: async () => {},
        log: () => {},
        maxActions: 5,
        evaluate: async () => ({
          allowed: true,
          reason: null,
          checks: [],
          automationMode: 'prepare-only',
          automationReason: 'Disposable provider double; never a live approval'
        }),
        authorizeAction: (action) =>
          linkedinActionPolicyGate(db!, sessionBody.auth.workspaceId, action.id)
      });
    const beforeApproval = await runSafeWorker();
    check(
      'L6 unapproved side effects are blocked',
      beforeApproval.executed === 0 && driverCalls === 0
    );
    // The queue was initially empty when this page mounted; a simulated tab
    // return must reveal the newly planned approval without reloading the page.
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const approve = page.getByRole('button', { name: 'Approve this action' });
    await approve.first().waitFor({ timeout: 25000 });
    check('L5 exact-message approval is visible to the browser operator', true);
    for (let i = 0; i < reviews.length; i++) {
      const approved = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          response.url().includes('/api/linkedin/manager/action-approvals/')
      );
      await approve.first().click();
      const result = await approved;
      check(
        'L5 exact approval POST succeeds',
        result.status() === 200,
        'status=' + result.status()
      );
    }
    await approve.first().waitFor({ state: 'hidden', timeout: 15000 });
    const afterApproval = (await (await page.request.get(reviewUrl)).json()).reviews;
    check('L5 owner approvals persist through real HTTP and UI', afterApproval.length === 0);
    const firstDelivery = await runSafeWorker();
    check(
      'L5 approved actions use controlled provider double',
      firstDelivery.executed > 0 && firstDelivery.executed === driverCalls
    );
    const secondDelivery = await runSafeWorker();
    check(
      'L6 retry does not duplicate a completed dispatch',
      secondDelivery.executed === 0 && driverCalls === firstDelivery.executed
    );

    // Shared Never Contact state comes from authenticated API; it may not
    // affect an action already executed. Separate provider-double tests cover
    // suppression before a send is permitted.
    const neverContact = await page.request.post(origin + '/api/suppressions', {
      data: { channel: 'email', email: 'jon@example.com', reason: 'Never Contact' }
    });
    check('L6 browser owner can record Never Contact restriction', neverContact.status() === 201);
    const suppressionRows = (await (await page.request.get(origin + '/api/suppressions')).json())
      .suppressions;
    check(
      'L6 suppression is durably readable by the authorized tenant',
      suppressionRows.some(
        (row: { email?: string; reason?: string }) =>
          row.email === 'jon@example.com' && row.reason === 'Never Contact'
      )
    );

    // A second separate owner must receive a different workspace; first
    // session must remain pinned to its original workspace.
    const secondContext = await browser.newContext();
    const secondPage = await secondContext.newPage();
    await secondPage.goto(origin + '/login', { waitUntil: 'domcontentloaded' });
    await prerequisite(secondPage, 'Create an account');
    await secondPage.getByRole('button', { name: 'Create an account' }).click();
    await secondPage.getByPlaceholder('Alex Morgan').fill('Second Operator');
    await secondPage
      .getByPlaceholder('you@company.com')
      .fill('isolated-second-user-' + Date.now() + '@example.test');
    await secondPage
      .getByPlaceholder('At least 10 characters')
      .fill('test-only-an-example-password-2026');
    const secondSignup = secondPage.waitForResponse(
      (r) => r.url().includes('/api/auth/sign-up/email'),
      { timeout: 30000 }
    );
    await secondPage.getByRole('button', { name: 'Create workspace' }).click();
    check('L1 second independent owner signs up', (await secondSignup).status() === 200);
    const secondSession = await (await secondPage.request.get(origin + '/api/auth/session')).json();
    const firstAgain = await (await page.request.get(origin + '/api/auth/session')).json();
    check(
      'L1 first two browser tenants have distinct workspace IDs',
      !!secondSession.auth?.workspaceId &&
        secondSession.auth.workspaceId !== sessionBody.auth.workspaceId &&
        firstAgain.auth?.workspaceId === sessionBody.auth.workspaceId
    );
    const foreignCampaign = await secondPage.request.get(
      origin + '/api/linkedin/manager/campaigns/' + reviewCampaign.id
    );
    check('L6 other tenant cannot read first tenant campaign', foreignCampaign.status() === 404);
    const foreignApproval = await secondPage.request.post(reviewUrl + '/' + reviews[0].actionId, {
      data: { contentHash: reviews[0].contentHash }
    });
    check('L6 other tenant cannot approve private action', foreignApproval.status() === 404);
    const foreignSuppressions = (
      await (await secondPage.request.get(origin + '/api/suppressions')).json()
    ).suppressions;
    check('L6 Never Contact entries do not leak across tenants', foreignSuppressions.length === 0);
    await secondContext.close();

    const fresh = await browser.newContext();
    const unauth = await fresh.request.get(origin + '/api/auth/session');
    check(
      'L1 fresh browser is isolated (401)',
      unauth.status() === 401,
      'status=' + unauth.status()
    );
    const forged = await fresh.request.get(origin + '/api/suppressions', {
      headers: { Cookie: 'trevra.session_token=synthetic-invalid-session' }
    });
    check(
      'L6 forged session is still charged to the anonymous IP rate bucket',
      forged.status() === 401 && (forged.headers()['ratelimit-policy'] ?? '').startsWith('300;')
    );
    await fresh.close();

    // The optional passkey UI is hosted-IdP-controlled. A real local app must
    // NOT advertise it; a synthetic public capability may show it, and a click
    // must start Better Auth's usual OAuth flow with an explicit method hint.
    const passkeyContext = await browser.newContext();
    const passkeyPage = await passkeyContext.newPage();
    await passkeyPage.goto(origin + '/login', { waitUntil: 'domcontentloaded' });
    await passkeyPage
      .getByRole('button', { name: 'Create an account' })
      .waitFor({ timeout: 25000 });
    check(
      'L1 passkey hidden unless Authward advertises capability',
      (await passkeyPage.getByRole('button', { name: 'Continue with passkey' }).count()) === 0
    );
    await passkeyPage.route('**/api/public-config', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          authwardAuthEnabled: true,
          passkeyAuthEnabled: true,
          socialAuthProviders: ['google'],
          magicLinkAuthEnabled: false,
          emailPasswordAuthEnabled: false
        })
      });
    });
    let passkeyOAuthStarts = 0;
    await passkeyPage.route('**/api/auth/sign-in/oauth2', async (route) => {
      passkeyOAuthStarts += 1;
      await route.fulfill({ status: 400, contentType: 'application/json', body: '{}' });
    });
    await passkeyPage.reload({ waitUntil: 'domcontentloaded' });
    const passkeyButton = passkeyPage.getByRole('button', { name: 'Continue with passkey' });
    await passkeyButton.waitFor({ timeout: 25000 });
    check('L1 passkey action appears only when provider capability is attested', true);
    const googleButton = passkeyPage.getByRole('button', { name: 'Continue with Google' });
    check(
      'L1 passkey + Google do not both appear as primary actions',
      (await passkeyPage.locator('.ol-auth-methods .ol-auth-primary').count()) === 1 &&
        (await passkeyButton.getAttribute('class'))?.includes('ol-auth-primary') === true &&
        (await googleButton.getAttribute('class'))?.includes('ol-auth-primary') === false
    );
    await passkeyButton.click();
    await passkeyPage
      .getByText('Passkey sign-in could not be completed.', { exact: false })
      .waitFor({ timeout: 12000 });
    check('L1 native passkey never redirects through Authward OAuth', passkeyOAuthStarts === 0);
    await passkeyContext.close();

    // Email links opened from a mail client may arrive in a new browser with
    // no Trevra state/PKCE cookie. Re-establish that state once, never loop.
    const recoveryContext = await browser.newContext();
    const recoveryPage = await recoveryContext.newPage();
    recoveryPage.on('pageerror', (error) =>
      errors.push('recovery: ' + error.message.slice(0, 200))
    );
    let oauthRecoveryStarts = 0;
    await recoveryPage.route('**/api/auth/sign-in/oauth2', async (route) => {
      oauthRecoveryStarts += 1;
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'Controlled recovery rejection' } })
      });
    });
    await recoveryPage.goto(origin + '/login?error=oauth_code_verification_failed', {
      waitUntil: 'domcontentloaded'
    });
    // A first cold page load can fail before React mounts. Only retry the
    // read-only page prerequisite; never repeat an OAuth POST.
    await prerequisite(recoveryPage, 'Create an account');
    await recoveryPage.waitForFunction(
      () => !new URL(location.href).searchParams.has('error'),
      null,
      { timeout: 12000 }
    );
    // A rejected synthetic OAuth POST can surface different error copy. The
    // security contract is a single browser-owned exchange and consumption of
    // the invalid callback state, not the wording of its warning.
    for (let attempt = 0; attempt < 20 && oauthRecoveryStarts === 0; attempt++) {
      await recoveryPage.waitForTimeout(100);
    }
    check(
      'L1 cross-browser magic-link callback starts one fresh OAuth transaction',
      oauthRecoveryStarts === 1 && !recoveryPage.url().includes('oauth_code_verification_failed')
    );
    await recoveryContext.close();

    // The *verified* Authward email link may open in a new Android Chrome
    // tab/WebView that never held the original Trevra OAuth state/PKCE cookie.
    // Trevra must create exactly one NEW browser-owned OAuth transaction.
    const emailContext = await browser.newContext();
    const emailPage = await emailContext.newPage();
    emailPage.on('pageerror', (error) => errors.push('email: ' + error.message.slice(0, 200)));
    let freshOAuthStarts = 0;
    await emailPage.route('**/api/auth/sign-in/oauth2', async (route) => {
      freshOAuthStarts += 1;
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'Synthetic OAuth failure' } })
      });
    });
    await emailPage.goto(origin + '/login?authward_session_ready=1', {
      waitUntil: 'domcontentloaded'
    });
    await prerequisite(emailPage, 'Create an account');
    await emailPage.waitForFunction(
      () => !new URL(location.href).searchParams.has('authward_session_ready'),
      null,
      { timeout: 12000 }
    );
    for (let attempt = 0; attempt < 20 && freshOAuthStarts === 0; attempt++) {
      await emailPage.waitForTimeout(100);
    }
    check(
      'L1 verified email link initiates one new OAuth session in receiving browser',
      freshOAuthStarts === 1 && !emailPage.url().includes('authward_session_ready')
    );
    await emailPage.goto(origin + '/login?authward_session_ready=1', {
      waitUntil: 'domcontentloaded'
    });
    // Do not assert a brittle fallback sentence. The security contract is
    // that the query hint is consumed and the same tab cannot start a second
    // outbound OAuth exchange, regardless of presentation copy.
    await emailPage.waitForFunction(
      () => !new URL(window.location.href).searchParams.has('authward_session_ready'),
      null,
      { timeout: 12000 }
    );
    await emailPage.waitForTimeout(500);
    check(
      'L1 repeated verified-email URL cannot create redirect loop',
      freshOAuthStarts === 1 && !emailPage.url().includes('authward_session_ready')
    );
    await emailContext.close();

    check('L1 UI has no uncaught page exception', errors.length === 0, errors.join('; '));
  } finally {
    const evidence = process.env.LAUNCH_ACCEPTANCE_REPORT_DIR;
    if (evidence && traceContext) {
      await evidencePage
        ?.screenshot({ path: join(evidence, 'browser-final.png'), fullPage: false })
        .catch(() => undefined);
      await traceContext.tracing
        .stop({ path: join(evidence, 'browser-trace.zip') })
        .catch(() => undefined);
    }
    await traceContext?.close();
    await browser?.close();
    if (listener) await new Promise<void>((resolve) => listener!.close(() => resolve()));
    await vite?.close();
    await db?.close();
    await closeAuthDb?.();
    if (containerId) await runDocker(['rm', '--force', containerId]).catch(() => undefined);
  }
  console.log(
    JSON.stringify(
      { isolated: true, noProviderActions: true, passed: assertions.length, checks: assertions },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        passed: false,
        checks: assertions,
        error: error instanceof Error ? error.message : String(error)
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
