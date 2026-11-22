import '../lib/load-env';
import { sql } from 'drizzle-orm';
import { db, primaryDatabaseHost } from '@kilocode/web-shared/lib/drizzle';
import { isLoopbackHostname } from '@kilocode/web-shared/lib/loopback-host';

function quotePostgresIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

// Dropping every schema is irreversible, so it only runs against a database on
// this machine. POSTGRES_SCRIPT_URL is the variable an `IS_SCRIPT` run reads, and
// the host comes from the URL the pool was built with, so the refusal cannot be
// fooled by a second copy of the value in the environment. No query runs before
// this: pg pools connect on demand, so a refused run never opens a socket.
const databaseHost = primaryDatabaseHost();

if (!isLoopbackHostname(databaseHost)) {
  console.error(
    `Refusing to reset the database at ${databaseHost}: it is not loopback. ` +
      'POSTGRES_SCRIPT_URL must name a local database for this script.'
  );
  process.exit(1);
}

async function main() {
  console.log('Resetting database (drop and recreate app schemas)...');

  const { rows } = await db.execute(sql`
    SELECT nspname
    FROM pg_namespace
    WHERE nspname NOT LIKE 'pg_%'
      AND nspname <> 'information_schema'
  `);

  for (const row of rows) {
    if (typeof row.nspname !== 'string') {
      continue;
    }

    console.log(`Dropping schema ${row.nspname}...`);
    await db.execute(
      sql.raw(`DROP SCHEMA IF EXISTS ${quotePostgresIdentifier(row.nspname)} CASCADE`)
    );
  }

  await db.execute(sql.raw('CREATE SCHEMA "public"'));

  console.log(
    'Database reset to empty app schemas. Run "pnpm drizzle migrate" to recreate our schema.'
  );
  process.exit(0);
}

main().catch(error => {
  console.error('Database reset failed:', error);
  process.exit(1);
});
