import '../lib/load-env';
import { sql } from 'drizzle-orm';
import { db } from '../lib/drizzle';

function quotePostgresIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
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
