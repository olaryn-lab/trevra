/**
 * Build, once per run, the migrated database every test file starts from.
 *
 * `vitest.setup.worker-db.ts` gives each test FILE a fresh copy of this
 * template (`CREATE DATABASE ... TEMPLATE`), so a file sees exactly the
 * database it would see running alone. Migrating here once keeps that copy
 * cheap: cloning the template takes a fraction of a second, migrating an
 * empty database takes seconds.
 *
 * App migrations and catalog seeding only -- the state `openDatabase()` leaves
 * a brand-new database in. better-auth's tables stay out: a file that needs
 * them runs `migrateAuthDatabase()` itself, as it must when it runs alone.
 */
import pg from 'pg';
import type { TestProject } from 'vitest/node';

const TEMPLATE_DATABASE = 'trevra_test_template';
/** The per-worker databases `vitest.setup.worker-db.ts` re-clones per file. */
const WORKER_DATABASE = /^trevra_test_w[0-9]+$/;

declare module 'vitest' {
  export interface ProvidedContext {
    trevraTemplateDatabase: string;
  }
}

async function onServer(adminUrl: string, work: (admin: pg.Client) => Promise<void>) {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await work(admin);
  } finally {
    await admin.end();
  }
}

export default async function setup(project: TestProject) {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) return;

  // Identifiers, not values -- CREATE/DROP DATABASE cannot take parameters.
  // Every name here is this file's own constant.
  await onServer(adminUrl, async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS "${TEMPLATE_DATABASE}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${TEMPLATE_DATABASE}"`);
  });
  const templateUrl = new URL(adminUrl);
  templateUrl.pathname = `/${TEMPLATE_DATABASE}`;
  const { openDatabase } = await import('./src/server/db.js');
  const template = await openDatabase({
    connectionString: templateUrl.toString(),
    seedDemo: false,
    autoMigrate: true
  });
  // A template cannot be cloned while anything is connected to it.
  await template.close();
  project.provide('trevraTemplateDatabase', TEMPLATE_DATABASE);

  return async () => {
    await onServer(adminUrl, async (admin) => {
      const { rows } = await admin.query<{ datname: string }>('SELECT datname FROM pg_database');
      for (const { datname } of rows) {
        if (datname === TEMPLATE_DATABASE || WORKER_DATABASE.test(datname))
          await admin.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
      }
    });
  };
}
