import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { applyMigrations, loadMigrations } from '../../scripts/migrator';
import { LOGIN_ROLES, databaseUrl, withAdmin } from './connection';

const TEMPLATE_DATABASE = 'uts_template';

async function dropDatabases(names: readonly string[]): Promise<void> {
  await withAdmin(undefined, async client => {
    for (const name of names) {
      await client.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)} WITH (FORCE)`);
    }
  });
}

/**
 * Migrates a template database once per run and gives the local logins a random password for
 * this run. Clones left by an interrupted run are dropped first.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const loginPassword = randomBytes(24).toString('base64url');
  const leftovers = await withAdmin(undefined, async client => {
    const result = await client.query<{ datname: string }>(
      String.raw`SELECT datname FROM pg_database WHERE datname LIKE 'uts\_t\_%'`
    );
    return result.rows.map(row => row.datname);
  });
  await dropDatabases([...leftovers, TEMPLATE_DATABASE]);
  await withAdmin(undefined, client => client.query(`CREATE DATABASE ${TEMPLATE_DATABASE}`));

  const template = new pg.Client({ connectionString: databaseUrl(TEMPLATE_DATABASE) });
  await template.connect();
  try {
    await applyMigrations(template, await loadMigrations());
    for (const login of LOGIN_ROLES) {
      await template.query(
        `ALTER ROLE ${pg.escapeIdentifier(login)} PASSWORD ${pg.escapeLiteral(loginPassword)}`
      );
    }
  } finally {
    await template.end();
  }

  project.provide('templateDatabase', TEMPLATE_DATABASE);
  project.provide('loginPassword', loginPassword);
  return () => dropDatabases([TEMPLATE_DATABASE]);
}
