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
    // Vite serves the ACTUAL React app through this isolated listener.
    // It has no API proxy and routes API calls to the above Express app.
    vite = await createViteServer({
      configFile: false,
      root: process.cwd(),
      appType: 'spa',
      plugins: [(await import('@vitejs/plugin-react')).default()],
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
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message.slice(0, 200)));
    const first = await page.goto(origin + '/login', {
      waitUntil: 'domcontentloaded',
      timeout: 20000
    });
    check('L1 local app shell loads', first?.status() === 200);
    try {
      await page.getByRole('button', { name: 'Create an account' }).waitFor({ timeout: 25000 });
    } catch {
      // First Vite dependency optimize on a cold checkout can interrupt the
      // initial app load. Retry once; persistent failures remain hard failures.
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.getByRole('button', { name: 'Create an account' }).waitFor({ timeout: 25000 });
    }
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
    await page.waitForTimeout(1300);
    check(
      'L1 page leaves login after signup',
      (await page.getByRole('button', { name: 'Create workspace' }).count()) === 0,
      'url=' + page.url()
    );
    console.log('L1 workspace created and readback, id omitted');
    // L5: exercise ACTUAL authenticated React screens, not a mocked UI.
    await page.goto(origin + '/outreach', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /New campaign/i }).waitFor({ timeout: 25000 });
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
    await page.getByRole('button', { name: /^Start$/ }).click();
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
    await page.getByRole('button', { name: /^Start$/ }).click();
    await page.getByRole('button', { name: 'Start this campaign' }).click();
    await page.getByRole('button', { name: /^Pause$/ }).waitFor({ timeout: 20000 });

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
    await page.goto(origin + '/outreach', { waitUntil: 'domcontentloaded' });
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
    await secondPage.getByRole('button', { name: 'Create an account' }).waitFor();
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
