/**
 * Hermetic L1 first-user browser acceptance.
 * Launches ONLY an ephemeral localhost test listener and a disposable PostgreSQL
 * container. No existing services, provider accounts or runtime databases touched.
 *
 *   npx tsx scripts/launch-mvp-hermetic-browser.ts
 */
import { spawn } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { once } from 'node:events';
import { chromium } from 'playwright';
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
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message.slice(0, 200)));
    const first = await page.goto(origin + '/login', {
      waitUntil: 'domcontentloaded',
      timeout: 20000
    });
    check('L1 local app shell loads', first?.status() === 200);
    await page.getByRole('button', { name: 'Create an account' }).waitFor({ timeout: 20000 });
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
    await secondContext.close();

    const fresh = await browser.newContext();
    const unauth = await fresh.request.get(origin + '/api/auth/session');
    check(
      'L1 fresh browser is isolated (401)',
      unauth.status() === 401,
      'status=' + unauth.status()
    );
    await fresh.close();
    check('L1 UI has no uncaught page exception', errors.length === 0, errors.join('; '));
    await ctx.close();
  } finally {
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
