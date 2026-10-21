#!/usr/bin/env node
/**
 * Launch-critical Trevra acceptance only. This invokes two independent,
 * disposable local environments; NO live LinkedIn/email integration, staging
 * deployment or Dripify-parity certification occurs.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = process.cwd();
const date = new Date().toISOString().replace(/[.:]/g, '-');
const reportDir = process.env.LAUNCH_ACCEPTANCE_REPORT_DIR
  ? resolve(process.env.LAUNCH_ACCEPTANCE_REPORT_DIR)
  : join(tmpdir(), 'trevra-launch-acceptance', date);
await mkdir(reportDir, { recursive: true });

const commands = [
  {
    id: 'browser',
    scope: 'L1/L5/L6 authenticated UI and provider-double boundary',
    args: ['scripts/launch-mvp-hermetic-browser.ts']
  },
  {
    id: 'controlled-providers',
    scope: 'L3-L7 campaign send/reply/bounce/suppression/unknown/recovery with mocks',
    args: [
      'scripts/test-with-postgres.ts',
      'src/server/linkedin/launch-mvp.acceptance.test.ts',
      'src/server/linkedin/companion-recovery.test.ts',
      'src/server/linkedin/companion-api.test.ts',
      'src/server/app-session-cookie.test.ts'
    ]
  }
];

async function run(command) {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const logParts = [];
  // Neither subprocess is allowed to inherit a configured live provider key.
  // Each creates its own isolated PostgreSQL, identity and provider doubles.
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (
      /^(NANGO_|AUTHWARD_|BILLING_|SMTP_|OPENAI_|ANTHROPIC_|STRIPE_|GITHUB_TOKEN$|GOOGLE_APPLICATION_CREDENTIALS$|AWS_ACCESS_KEY_ID$|AWS_SECRET_ACCESS_KEY$|TREVRA_BROWSER_|TREVRA_COMPANION_|TREVRA_LINKEDIN_)/.test(
        key
      )
    ) {
      delete childEnv[key];
    }
  }
  childEnv.LAUNCH_ACCEPTANCE_MODE = 'controlled-local-only';
  childEnv.LAUNCH_ACCEPTANCE_REPORT_DIR = reportDir;
  const child = spawn(resolve(root, 'node_modules/.bin/tsx'), command.args, {
    cwd: root,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const append = (stream, output) => {
    stream.on('data', (chunk) => {
      const value = String(chunk);
      output.write(value);
      logParts.push(value);
    });
  };
  append(child.stdout, process.stdout);
  append(child.stderr, process.stderr);
  const exitCode = await new Promise((resolveExit) => {
    child.on('error', () => resolveExit(1));
    child.on('close', (code) => resolveExit(code ?? 1));
  });
  // Logs contain only synthetic identities; still kept in a private local
  // directory, never attached or uploaded automatically.
  const logName = command.id + '.log';
  await writeFile(join(reportDir, logName), logParts.join(''), { mode: 0o600 });
  const combined = logParts.join('');
  const browserCount =
    command.id === 'browser' ? Number(combined.match(/"passed":\s*(\d+)/)?.[1] ?? 0) : null;
  return {
    id: command.id,
    scope: command.scope,
    exitCode,
    passed: exitCode === 0,
    startedAt,
    durationSeconds: Math.round((Date.now() - start) / 1000),
    ...(browserCount !== null ? { browserChecksPassed: browserCount } : {}),
    evidenceLog: logName
  };
}

const phases = [];
for (const command of commands) {
  process.stdout.write('\n### Trevra launch acceptance: ' + command.id + '\n');
  phases.push(await run(command));
}
const report = {
  title: 'Trevra launch MVP controlled acceptance',
  generatedAt: new Date().toISOString(),
  execution: 'disposable local PostgreSQL and API / Playwright; provider doubles only',
  result: phases.every((phase) => phase.passed) ? 'LOCAL_ACCEPTANCE_PASS' : 'LOCAL_ACCEPTANCE_FAIL',
  phases,
  hostedGatesVerified: false,
  firstCustomerGo: false,
  stillRequires: [
    'Dedicated staging Authward callback and authenticated test identity',
    'Staging worker revision, schema migration, alerts and backup restoration',
    'Permitted LinkedIn Companion and mailbox provider acceptance',
    'Legal/consent and commercial sign-off'
  ]
};
await writeFile(join(reportDir, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
  mode: 0o600
});
console.log('LAUNCH_ACCEPTANCE_REPORT=' + join(reportDir, 'report.json'));
console.log('LAUNCH_ACCEPTANCE_RESULT=' + report.result);
process.exitCode = report.result === 'LOCAL_ACCEPTANCE_PASS' ? 0 : 1;
