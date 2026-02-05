import { db } from '@/lib/drizzle';
import { kilocode_users, microdollar_usage } from '@/db/schema';
import { sql } from 'drizzle-orm';

/**
 * Phase 1: Tag eligible inactive users into the 'cli-v1-rollout' cohort.
 *
 * Eligible = non-blocked users who have used Kilo before but not in the last 30 days.
 *
 * Uses subqueries so the database handles the filtering — no large arrays
 * materialized in application memory.
 *
 * Idempotent: users already in the cohort are skipped via the
 * NOT (cohorts ? <cohort_name>) guard.
 *
 * Usage:
 *   pnpm script src/scripts/d2025-02-04_cli-v1-rollout-cohort.ts           # dry run
 *   pnpm script src/scripts/d2025-02-04_cli-v1-rollout-cohort.ts --apply   # apply
 */

const INACTIVE_DAYS = 30;
const COHORT_NAME = 'cli-v1-rollout';

export async function tagInactiveUsersIntoCohort(options: {
  cohortName: string;
  inactiveDays: number;
  dryRun: boolean;
}): Promise<{ tagged: number }> {
  const cutoffIso = new Date(Date.now() - options.inactiveDays * 24 * 60 * 60 * 1000).toISOString();
  const now = Date.now();

  const everUsed = sql`(SELECT DISTINCT ${microdollar_usage.kilo_user_id} FROM ${microdollar_usage})`;
  const recentlyActive = sql`(SELECT DISTINCT ${microdollar_usage.kilo_user_id} FROM ${microdollar_usage} WHERE ${microdollar_usage.created_at} >= ${cutoffIso})`;

  if (options.dryRun) {
    const countResult = await db.execute<{ count: string }>(sql`
      SELECT COUNT(*) AS count
      FROM ${kilocode_users}
      WHERE ${kilocode_users.blocked_reason} IS NULL
        AND ${kilocode_users.id} IN ${everUsed}
        AND ${kilocode_users.id} NOT IN ${recentlyActive}
        AND NOT (${kilocode_users.cohorts} ? ${options.cohortName})
    `);

    return { tagged: Number(countResult.rows[0].count) };
  }

  const result = await db.execute<{ count: string }>(sql`
    WITH updated AS (
      UPDATE ${kilocode_users}
      SET cohorts = cohorts || jsonb_build_object(${options.cohortName}::text, ${now}::bigint)
      WHERE ${kilocode_users.blocked_reason} IS NULL
        AND ${kilocode_users.id} IN ${everUsed}
        AND ${kilocode_users.id} NOT IN ${recentlyActive}
        AND NOT (cohorts ? ${options.cohortName}::text)
      RETURNING ${kilocode_users.id}
    )
    SELECT COUNT(*) AS count FROM updated
  `);

  return { tagged: Number(result.rows[0].count) };
}

async function run() {
  const isDryRun = !process.argv.includes('--apply');

  console.log('Phase 1: Tagging inactive users into cohort...\n');
  if (isDryRun) {
    console.log('DRY RUN MODE - No changes will be made');
    console.log('Run with --apply flag to write cohort tags\n');
  }

  const { tagged } = await tagInactiveUsersIntoCohort({
    cohortName: COHORT_NAME,
    inactiveDays: INACTIVE_DAYS,
    dryRun: isDryRun,
  });

  if (isDryRun) {
    console.log(`Would tag ${tagged} users into cohort '${COHORT_NAME}'`);
  } else {
    console.log(`Tagged ${tagged} users into cohort '${COHORT_NAME}'`);
  }
}

// Only run if executed directly (not imported as a module for testing)
if (require.main === module || process.argv[1]?.endsWith('d2025-02-04_cli-v1-rollout-cohort.ts')) {
  run()
    .then(() => {
      console.log('\nScript completed successfully');
      process.exit(0);
    })
    .catch(error => {
      console.error('\nScript failed:', error);
      process.exit(1);
    });
}
