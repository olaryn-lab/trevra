/**
 * Give every test FILE a fresh Postgres database of its own.
 *
 * WHY THIS EXISTS: `scripts/test-with-postgres.ts` starts exactly one
 * ephemeral Postgres container for the whole run, and `resetDemoData()`
 * (`src/server/db.ts`) deletes and reseeds ONE fixed workspace --
 * `DEMO_WORKSPACE_ID = 'ws_demo'` -- on every call. Two test files sharing
 * that workspace concurrently would have one file's `beforeEach` deleting
 * rows the other file is mid-assertion against.
 *
 * ONE DATABASE PER WORKER WAS NOT ENOUGH. Files on different workers could no
 * longer race, but every file a worker ran inherited whatever the files before
 * it on that worker left behind -- and which files those were changed from
 * run to run. A query that reads past its own workspace
 * (`runManagedCampaignsForAllWorkspaces` ticks every running campaign in the
 * database) then counted another file's leftovers, and failed only in the
 * full suite.
 *
 * THE FIX: before each file, drop the worker's database (`trevra_test_w<N>`,
 * keyed by `VITEST_POOL_ID`, so two files running at the same instant never
 * share one) and re-create it from the template `vitest.global-setup.ts`
 * migrated once for the run. Every file starts from exactly the database it
 * would get running alone. `WITH (FORCE)` also cuts off any connection the
 * previous file's exiting worker process still holds.
 *
 * vitest starts a new process per file (`isolate`), and this runs before
 * vitest.setup.ts or the test file is imported -- auth-service.ts reads
 * DATABASE_URL at import time, not lazily.
 */
import pg from 'pg';
import { inject } from 'vitest';

const { Client } = pg;

// The server-level connection the per-file databases are created over. Kept
// apart from TEST_DATABASE_URL, which this file repoints at the file's own
// database -- a later file in the same process must not try to drop the
// database it is connected to.
const adminUrl = process.env.TREVRA_TEST_ADMIN_DATABASE_URL ?? process.env.TEST_DATABASE_URL;

if (adminUrl) {
  process.env.TREVRA_TEST_ADMIN_DATABASE_URL = adminUrl;
  const dbName = `trevra_test_w${process.env.VITEST_POOL_ID ?? '1'}`;
  // Absent only if a config runs this without vitest.global-setup.ts: the
  // file then still gets a fresh database, and openDatabase() migrates it.
  const template = inject('trevraTemplateDatabase');

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    // Not parameterizable -- CREATE/DROP DATABASE take identifiers, not
    // values. Both names are our own: a vitest-assigned integer and the
    // global setup's constant, never user input.
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.query(
      template
        ? `CREATE DATABASE "${dbName}" TEMPLATE "${template}"`
        : `CREATE DATABASE "${dbName}"`
    );
  } finally {
    await admin.end();
  }

  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  const fileUrl = url.toString();
  // Both names matter: test files pass TEST_DATABASE_URL explicitly to
  // openDatabase(); auth-service.ts reads DATABASE_URL directly at import
  // time. Setting both before the test file (and therefore auth-service.ts)
  // is imported is what makes better-auth land on the same database as
  // everything else this file touches.
  process.env.DATABASE_URL = fileUrl;
  process.env.TEST_DATABASE_URL = fileUrl;
}
