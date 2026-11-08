import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Migrates, once per run, the template every test file's database is
    // cloned from (see vitest.global-setup.ts).
    globalSetup: ['./vitest.global-setup.ts'],
    // Order matters: the worker-db setup must give this file its fresh
    // database (see vitest.setup.worker-db.ts) before vitest.setup.ts or the
    // test file itself runs, since auth-service.ts reads DATABASE_URL at
    // import time, not lazily.
    setupFiles: ['./vitest.setup.worker-db.ts', './vitest.setup.ts'],
    // Each test file gets its own fresh Postgres database
    // (vitest.setup.worker-db.ts), so files never share the one fixed demo
    // workspace `resetDemoData()` deletes and reseeds, nor each other's
    // leftovers -- safe to parallelize.
    fileParallelism: true,
    // Bounded rather than left at vitest's CPU-count default: every worker
    // opens its own connection pools (app pool + better-auth pool), and an
    // unbounded worker count could push total connections toward Postgres's
    // default max_connections (100) on a big-core CI box. Override with
    // VITEST_MAX_WORKERS if a given machine can safely take more.
    maxWorkers: Number(process.env.VITEST_MAX_WORKERS ?? 4),
    hookTimeout: 120_000,
    testTimeout: 60_000,
    // Exclude stale Claude worktrees and nested task worktrees (.worktrees/)
    // that duplicate src/ test files and cause shared-database collisions
    // during parallel runs.
    exclude: ['.claude/**', '.worktrees/**', '**/node_modules/**']
  }
});
