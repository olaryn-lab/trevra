#!/usr/bin/env node
/**
 * Read-only launch-MVP smoke (no login or provider action):
 * node scripts/launch-mvp-readonly-smoke.mjs --origin https://staging.example.test
 * Optional --issuer https://auth.example.test --worker-origin https://worker.example.test
 *
 * HTTP methods other than GET and HEAD are blocked. Passing means only that
 * the anonymous entry point works; it does NOT certify onboarding or a launch.
 */
import { chromium } from 'playwright';

function parseOrigin(raw) {
  const value = new URL(raw);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(value.hostname);
  if (
    (value.protocol !== 'https:' && !(loopback && value.protocol === 'http:')) ||
    value.username ||
    value.password ||
    value.search ||
    value.hash ||
    value.pathname !== '/'
  )
    throw new Error('Expected plain HTTPS origin (HTTP only for loopback)');
  return value.origin;
}

function argumentsFor(values) {
  const accepted = ['--origin', '--issuer', '--worker-origin'];
  const parsed = {};
  for (let i = 0; i < values.length; i += 2) {
    if (!accepted.includes(values[i]) || !values[i + 1] || parsed[values[i]]) {
      throw new Error('Usage: --origin ORIGIN [--issuer ORIGIN] [--worker-origin ORIGIN]');
    }
    parsed[values[i]] = parseOrigin(values[i + 1]);
  }
  if (!parsed['--origin']) throw new Error('Explicit --origin required; no production default');
  return parsed;
}

async function jsonGet(request, url, fields) {
  try {
    const response = await request.get(url, { timeout: 10000, maxRedirects: 0 });
    const info = { http: response.status(), reachable: response.ok() };
    if (!response.ok()) return info;
    const value = await response.json();
    for (const key of fields) {
      if (['string', 'boolean'].includes(typeof value[key])) info[key] = value[key];
      if (key === 'socialAuthProviders' && Array.isArray(value[key])) {
        info[key] = value[key].filter((entry) => typeof entry === 'string');
      }
    }
    return info;
  } catch (error) {
    return { reachable: false, errorType: error instanceof Error ? error.name : 'unknown' };
  }
}

async function browserSmoke(browser, origin) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  let blockedMethods = 0;
  let pageErrors = 0;
  await context.route('**/*', (route) => {
    if (!['GET', 'HEAD'].includes(route.request().method())) {
      blockedMethods++;
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', () => pageErrors++);
  const result = { loginVisible: false, emailFieldVisible: false };
  try {
    const response = await page.goto(origin + '/', {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    });
    result.entryHttp = response?.status() ?? null;
    let emailChoice = page.getByRole('button', { name: /continue with email/i });
    if (!(await emailChoice.count())) {
      // Never follow a marketing CTA: it may leave this test origin.
      const loginResponse = await page.goto(origin + '/login', {
        waitUntil: 'domcontentloaded',
        timeout: 15000
      });
      result.loginHttp = loginResponse?.status() ?? null;
    }
    await page.waitForTimeout(500);
    emailChoice = page.getByRole('button', { name: /continue with email/i });
    result.loginVisible = (await emailChoice.count()) > 0;
    result.googleVisible =
      (await page.getByRole('button', { name: /continue with google/i }).count()) > 0;
    result.microsoftVisible =
      (await page.getByRole('button', { name: /continue with microsoft/i }).count()) > 0;
    result.termsVisible = (await page.getByRole('link', { name: /^terms$/i }).count()) > 0;
    result.privacyVisible =
      (await page.getByRole('link', { name: /privacy( notice)?/i }).count()) > 0;
    if (result.loginVisible) {
      if (!(await page.locator('input[type=email]').count())) {
        // This is a local UI toggle. Never fill or submit an email address.
        await emailChoice.click({ timeout: 5000 });
      }
      result.emailFieldVisible = (await page.locator('input[type=email]').count()) > 0;
    }
    result.passed = result.entryHttp === 200 && result.loginVisible && result.emailFieldVisible;
  } catch (error) {
    result.passed = false;
    result.errorType = error instanceof Error ? error.name : 'unknown';
  } finally {
    result.blockedUnsafeRequests = blockedMethods;
    result.pageErrors = pageErrors;
    await context.close();
  }
  return result;
}

async function callbackErrorSmoke(browser, origin) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', (route) => {
    if (!['GET', 'HEAD'].includes(route.request().method())) {
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  const page = await context.newPage();
  const outcomes = [];
  try {
    for (const [code, expected] of [
      ['invalid_client', 'temporarily unavailable'],
      ['oauth_code_verification_failed', 'temporarily unavailable'],
      ['INVALID_TOKEN', 'invalid, expired, or has already been used'],
      ['state_mismatch', 'could not complete your sign-in']
    ]) {
      // A fake raw provider description must never be echoed into the page.
      const sentinel = 'PROVIDER_RAW_DESCRIPTION_MUST_NOT_RENDER';
      await page.goto(
        origin + '/login?error=' + encodeURIComponent(code) + '&error_description=' + sentinel,
        { waitUntil: 'domcontentloaded', timeout: 15000 }
      );
      await page.waitForTimeout(300);
      const visible = await page.evaluate(() => ({
        alerts: Array.from(document.querySelectorAll('[role="alert"]')).map(
          (element) => element.textContent ?? ''
        ),
        text: document.body?.innerText ?? '',
        query: location.search
      }));
      const safe =
        visible.alerts.some((item) => item.toLowerCase().includes(expected)) &&
        !visible.text.includes(sentinel) &&
        !visible.query.includes(sentinel);
      outcomes.push({ code, friendlyErrorVisible: safe });
    }
  } finally {
    await context.close();
  }
  return {
    passed: outcomes.length === 4 && outcomes.every((item) => item.friendlyErrorVisible),
    outcomes
  };
}

async function main() {
  const options = argumentsFor(process.argv.slice(2));
  const origin = options['--origin'];
  const report = {
    category: 'anonymous-read-only-smoke',
    origin,
    stagingIdentityVerified: false,
    api: null,
    publicConfig: null,
    identity: null,
    worker: null,
    browser: null,
    notTested: [
      'Authenticated sign-in and tenant onboarding',
      'Provider authorization, sends and mailbox sync',
      'Campaign browser flow, live database schema and worker cycle',
      'Alert delivery and backup restore'
    ]
  };
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
      report.api = await jsonGet(context.request, origin + '/api/health', [
        'ok',
        'service',
        'database',
        'integrations'
      ]);
      report.publicConfig = await jsonGet(context.request, origin + '/api/public-config', [
        'authwardAuthEnabled',
        'socialAuthProviders',
        'magicLinkAuthEnabled'
      ]);
      if (options['--issuer']) {
        report.identity = await jsonGet(
          context.request,
          options['--issuer'] + '/.well-known/openid-configuration',
          ['issuer']
        );
      }
      if (options['--worker-origin']) {
        report.worker = await jsonGet(context.request, options['--worker-origin'] + '/health', [
          'ok',
          'service',
          'orchestrator'
        ]);
      }
    } finally {
      await context.close();
    }
    report.browser = await browserSmoke(browser, origin);
    report.callbackErrors = await callbackErrorSmoke(browser, origin);
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(report, null, 2));
  const passed =
    report.api?.reachable &&
    report.api.ok === true &&
    report.publicConfig?.reachable &&
    report.browser?.passed &&
    (!options['--issuer'] || report.identity?.reachable) &&
    (!options['--worker-origin'] || (report.worker?.reachable && report.worker.ok === true));
  process.exitCode = passed ? 0 : 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Smoke tool failed');
  process.exitCode = 1;
});
