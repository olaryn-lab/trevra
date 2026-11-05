/**
 * Real local browser + API + isolated PostgreSQL smoke for PR #43.
 *
 * Uses the actual React app, authenticated HTTP routes, source-leads skill,
 * workspace accounts and a headless Chromium. Only the external OSM/store
 * fetch boundary is a deterministic fixture. No real users/credentials are read.
 * Run: npx tsx scripts/smoke-dach-footwear-local.ts
 */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer as createTcpServer, type Server } from 'node:net';
import { once } from 'node:events';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer as createViteServer, type ViteDevServer } from 'vite';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function docker(args: string[]): Promise<string> {
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => {
    out += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    err += String(chunk);
  });
  const [code] = (await once(child, 'close')) as [number];
  if (code !== 0) throw new Error('docker ' + args[0] + ': ' + err.slice(0, 500));
  return out.trim();
}
async function freePort() {
  const listener = createTcpServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = (listener.address() as { port: number }).port;
  listener.close();
  await once(listener, 'close');
  return port;
}
async function main() {
  for (const key of Object.keys(process.env)) {
    if (
      /^(NANGO_|AUTHWARD_|BILLING_|SMTP_|OPENAI_|STRIPE_|TREVRA_BROWSER_|TREVRA_COMPANION_|TREVRA_LINKEDIN_)/.test(
        key
      )
    ) {
      delete process.env[key];
    }
  }
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  process.env.NODE_ENV = 'test';
  process.env.TREVRA_DEPLOYMENT_MODE = 'local';
  process.env.APP_ORIGIN = origin;
  process.env.BETTER_AUTH_URL = origin;
  process.env.BETTER_AUTH_SECRET = 'isolated-footwear-browser-test-only-32-byte-minimum';
  process.env.PUBLIC_SITE_URL = origin;
  process.env.COOKIE_SECURE = 'false';
  process.env.ALLOW_DEMO_AUTH = 'false';
  process.env.TREVRA_SECRETS_KEY = Buffer.alloc(32, 77).toString('base64');
  process.env.TREVRA_ORCHESTRATOR = 'postgres';

  let container: string | null = null;
  let appServer: Server | null = null;
  let vite: ViteDevServer | null = null;
  let browser: Browser | null = null;
  let page: Page | null = null;
  let db: Awaited<ReturnType<typeof import('../src/server/db.js').openDatabase>> | null = null;
  let closeAuthDatabase: (() => Promise<void>) | null = null;
  try {
    container = await docker([
      'run',
      '--rm',
      '--detach',
      '--name',
      `trevra-dach-smoke-${process.pid}-${randomUUID().slice(0, 6)}`,
      '-e',
      'POSTGRES_DB=trevra_dach_smoke',
      '-e',
      'POSTGRES_USER=trevra',
      '-e',
      'POSTGRES_PASSWORD=isolated-only',
      '-p',
      '127.0.0.1::5432',
      'postgres:17-alpine'
    ]);
    let dbPort = '';
    for (let i = 0; i < 90; i += 1) {
      try {
        await docker([
          'exec',
          container,
          'pg_isready',
          '-h',
          '127.0.0.1',
          '-U',
          'trevra',
          '-d',
          'trevra_dach_smoke'
        ]);
        dbPort = (await docker(['port', container, '5432/tcp'])).match(/:(\d+)$/)?.[1] ?? '';
        if (dbPort) break;
      } catch {
        /* Postgres starting. */
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert(dbPort, 'PostgreSQL did not become ready');
    const databaseUrl = `postgresql://trevra:isolated-only@127.0.0.1:${dbPort}/trevra_dach_smoke`;
    process.env.DATABASE_URL = databaseUrl;
    process.env.TEST_DATABASE_URL = databaseUrl;
    const { openDatabase } = await import('../src/server/db.js');
    const auth = await import('../src/server/auth-service.js');
    closeAuthDatabase = auth.closeAuthDatabase;
    const { createApp } = await import('../src/server/app.js');
    const { getProvider } = await import('../src/server/research/registry.js');
    db = await openDatabase({ connectionString: databaseUrl, seedDemo: false });
    await auth.migrateAuthDatabase();

    // Only the network boundary is simulated. Preserve both real providers'
    // parsing/detection behavior, and exercise the full HTTP/skill/DB/UI route.
    let upstreamUnavailable = false;
    const requestedUrls: string[] = [];
    const fakeFetch = async (url: string): Promise<Response> => {
      requestedUrls.push(url);
      if (url.includes('overpass.private.coffee')) {
        if (upstreamUnavailable) return new Response('try again', { status: 429 });
        return new Response(
          JSON.stringify({
            elements: [
              {
                type: 'node',
                id: 21,
                tags: { name: 'Berlin ShoeAI Shop', website: 'shoeai-berlin-smoke.com' }
              },
              {
                type: 'node',
                id: 22,
                tags: { name: 'Berlin Footwear Shop', website: 'footwear-berlin-smoke.com' }
              },
              {
                type: 'node',
                id: 23,
                tags: { name: 'Disallowed Shop', website: 'blocked-berlin-smoke.com' }
              }
            ]
          }),
          { headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes('blocked-berlin-smoke.com/robots.txt')) {
        return new Response('User-agent: TrevraCrawler\nDisallow: /', {
          headers: { 'content-type': 'text/plain' }
        });
      }
      if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
      if (url.includes('shoeai-berlin-smoke.com/products/sneaker')) {
        return new Response('<script src="https://shoesize.me/assets/plugin/loader.js"></script>', {
          headers: { 'content-type': 'text/html' }
        });
      }
      if (url.includes('shoeai-berlin-smoke.com')) {
        return new Response(
          '<h1>Schuhe</h1><div>Warenkorb</div><a href="/products/sneaker">Sneaker</a>',
          {
            headers: { 'content-type': 'text/html' }
          }
        );
      }
      if (url.includes('footwear-berlin-smoke.com')) {
        return new Response('<h1>Schuhe</h1><div>Warenkorb</div>', {
          headers: { 'content-type': 'text/html' }
        });
      }
      throw new Error('Unexpected external URL in smoke: ' + url);
    };
    for (const key of ['shoeai-dach', 'dach-footwear']) {
      const provider = getProvider(key);
      assert(provider, 'Missing ' + key + ' provider');
      const search = provider.search.bind(provider);
      provider.search = (query, options) => search(query, { ...options, fetchImpl: fakeFetch });
    }

    const app = createApp(db);
    vite = await createViteServer({
      configFile: false,
      root: process.cwd(),
      appType: 'spa',
      plugins: [(await import('@vitejs/plugin-react')).default()],
      optimizeDeps: { entries: ['src/client/main.tsx'] },
      server: { middlewareMode: true, hmr: false }
    });
    app.use(vite.middlewares);
    appServer = app.listen(port, '127.0.0.1');
    await once(appServer, 'listening');
    console.log('Trevra local browser app listening at', origin);
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const login = await page.goto(origin + '/login', { waitUntil: 'domcontentloaded' });
    assert(login?.status() === 200, 'App /login did not return 200');
    await page.getByRole('button', { name: 'Create an account' }).waitFor({ timeout: 25000 });
    await page.getByRole('button', { name: 'Create an account' }).click();
    await page.getByPlaceholder('Alex Morgan').fill('Local Footwear Tester');
    await page.getByPlaceholder('you@company.com').fill(`footwear-${Date.now()}@example.test`);
    await page.getByPlaceholder('At least 10 characters').fill('isolation-only-test-password-2026');
    const signup = page.waitForResponse((r) => r.url().includes('/api/auth/sign-up/email'));
    await page.getByRole('button', { name: 'Create workspace' }).click();
    const signed = await signup;
    assert(signed.status() === 200, 'Local sign-up status: ' + signed.status());
    await page.waitForURL('**/loop', { timeout: 18000 });
    const session = await page.request.get(origin + '/api/auth/session');
    const { auth: owner } = (await session.json()) as {
      auth: { workspaceId?: string; role?: string };
    };
    assert(owner?.workspaceId && owner.role === 'owner', 'Missing authenticated owner workspace');
    console.log('PASS: local signup + owner session + React workspace');

    await page.goto(origin + '/outreach', { waitUntil: 'domcontentloaded' });
    await page.locator('details#accounts > summary').click();
    await page.locator('details.acc-source-panel > summary').click();
    const providerSelect = page.locator('.acc-source-panel .ui-select-trigger').first();
    const providerReply = await page.request.get(origin + '/api/accounts/source-providers');
    const providerJson = (await providerReply.json()) as { providers?: Array<{ key: string }> };
    assert(
      providerReply.status() === 200 &&
        providerJson.providers?.some((provider) => provider.key === 'shoeai-dach') &&
        providerJson.providers?.some((provider) => provider.key === 'dach-footwear'),
      'New providers were not registered in the authenticated API'
    );
    await providerSelect.click();
    // A queued document scroll previously closed every portalled dropdown.
    // It must remain open after the opening layout/focus has settled.
    await page.waitForTimeout(350);
    assert(
      (await providerSelect.getAttribute('aria-expanded')) === 'true',
      'Provider dropdown immediately closed after opening'
    );
    assert(
      (await page.locator('[role="listbox"]').count()) === 1,
      'Provider dropdown did not render its choices'
    );
    await page
      .getByRole('option', { name: /DACH footwear · ShoeAI traces/ })
      .click({ timeout: 4000 });
    await page.getByLabel('Cities (optional)').fill('Berlin');
    await page.locator('.acc-source-panel .ui-select-trigger').nth(1).click();
    await page.getByRole('option', { name: 'Germany', exact: true }).click();
    const request = async () => {
      const responsePromise = page!.waitForResponse(
        (r) => r.url().endsWith('/api/accounts/source') && r.request().method() === 'POST',
        { timeout: 30000 }
      );
      await page!.getByRole('button', { name: 'Find accounts', exact: true }).click();
      const response = await responsePromise;
      return {
        status: response.status(),
        payload: (await response.json()) as {
          found: number;
          candidates: Array<{ domain: string; description: string; sourceUrl: string }>;
          import: { created: number; duplicate: number };
          warnings: string[];
        }
      };
    };
    const shoeai = await request();
    assert(shoeai.status === 201, 'ShoeAI source HTTP: ' + shoeai.status);
    assert(
      shoeai.payload.found === 1 && shoeai.payload.import.created === 1,
      'ShoeAI must find and import exactly one marked store'
    );
    assert(
      shoeai.payload.candidates[0]?.domain === 'shoeai-berlin-smoke.com',
      'Wrong ShoeAI store'
    );
    assert(
      shoeai.payload.candidates[0]?.description?.includes('ShoeAI marker'),
      'Missing ShoeAI qualification'
    );
    assert(
      shoeai.payload.candidates[0]?.sourceUrl === 'https://www.openstreetmap.org/node/21',
      'Missing evidence source'
    );
    await page.locator('.acc-source-result details > summary').click();
    await page.getByText('shoeai-berlin-smoke.com').first().waitFor();
    const firstAccounts = await db
      .prepare('SELECT domain,tags FROM accounts WHERE workspace_id=? ORDER BY domain')
      .all<{ domain: string; tags: string[] }>(owner.workspaceId);
    assert(
      firstAccounts.length === 1 && firstAccounts[0].tags.includes('shoeai-dach'),
      'ShoeAI account not persisted/tagged in the correct workspace'
    );
    assert(
      !requestedUrls.some(
        (url) => url.includes('blocked-berlin-smoke.com/') && !url.endsWith('/robots.txt')
      ),
      'Crawler ignored a robots.txt block'
    );
    console.log('PASS: browser ShoeAI filter → API → skill → database → evidence UI');

    await providerSelect.click();
    await page
      .getByRole('option', { name: /DACH footwear · online shops/ })
      .click({ timeout: 4000 });
    const footwear = await request();
    assert(footwear.status === 201, 'Footwear source HTTP: ' + footwear.status);
    assert(
      footwear.payload.found === 2 &&
        footwear.payload.import.created === 1 &&
        footwear.payload.import.duplicate === 1,
      'Footwear candidate discovery / dedup failed'
    );
    const accounts = await db
      .prepare('SELECT domain FROM accounts WHERE workspace_id=? ORDER BY domain')
      .all<{ domain: string }>(owner.workspaceId);
    assert(
      accounts.length === 2 && accounts.some((row) => row.domain === 'footwear-berlin-smoke.com'),
      'Second store was not added correctly'
    );
    console.log('PASS: general footwear discovery adds a store without duplicating ShoeAI account');

    upstreamUnavailable = true;
    const unavailable = await request();
    assert(
      unavailable.status === 200 &&
        unavailable.payload.found === 0 &&
        unavailable.payload.import.created === 0 &&
        unavailable.payload.warnings.some((warning) => warning.includes('429')),
      'Upstream failure must yield explicit warning and zero new accounts'
    );
    await page.getByText(/OSM returned HTTP 429/).waitFor();
    console.log('PASS: rate-limited public source is visible as a warning, not fake leads');

    await page.setViewportSize({ width: 390, height: 844 });
    const sizes = await page.locator('.acc-source-panel').evaluate((node) => ({
      panel: node.getBoundingClientRect().width,
      viewport: window.innerWidth,
      overflowing: document.documentElement.scrollWidth > window.innerWidth + 2
    }));
    assert(
      sizes.panel <= sizes.viewport + 2 && !sizes.overflowing,
      'Discovery panel overflows mobile width: ' + JSON.stringify(sizes)
    );
    assert(errors.length === 0, 'Uncaught browser errors: ' + errors.join('; '));
    console.log('PASS: mobile viewport and no uncaught browser JS errors');
    console.log('DACH browser smoke: ALL PASSED');
  } catch (error) {
    if (page) {
      await page
        .screenshot({ path: '/tmp/trevra-dach-browser-failure.png' })
        .catch(() => undefined);
      console.error('Browser screenshot on failure: /tmp/trevra-dach-browser-failure.png');
    }
    throw error;
  } finally {
    await browser?.close().catch(() => undefined);
    await vite?.close().catch(() => undefined);
    if (appServer) await new Promise<void>((resolve) => appServer!.close(() => resolve()));
    await db?.close().catch(() => undefined);
    await closeAuthDatabase?.().catch(() => undefined);
    if (container) await docker(['rm', '--force', container]).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
