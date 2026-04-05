import '../lib/load-env';
import { sql } from 'drizzle-orm';
import { db } from '../lib/drizzle';

async function main() {
  console.log('Emptying database (drop all tables+views)...');

  const { rows: tables } = await db.execute(
    sql`SELECT schemaname, tablename FROM pg_tables WHERE schemaname NOT IN ('information_schema', 'pg_catalog')`
  );

  for (const { schemaname, tablename } of tables) {
    if (typeof schemaname === 'string' && typeof tablename === 'string') {
      console.log(`Dropping table ${schemaname}.${tablename}...`);
      await db.execute(sql.raw(`DROP TABLE "${schemaname}"."${tablename}" CASCADE`));
    }
  }

  const { rows: views } = await db.execute(
    sql`SELECT schemaname, viewname FROM pg_views WHERE schemaname NOT IN ('information_schema', 'pg_catalog')`
  );

  for (const { schemaname, viewname } of views) {
    if (typeof schemaname === 'string' && typeof viewname === 'string') {
      console.log(`Dropping view ${schemaname}.${viewname}...`);
      await db.execute(sql.raw(`DROP VIEW "${schemaname}"."${viewname}" CASCADE`));
    }
  }

  console.log('Database emptied!  You should run "pnpm drizzle migrate" to recreate our schema.');
  process.exit(0);
}

main().catch(error => {
  console.error('Database emptying failed:', error);
  process.exit(1);
});
