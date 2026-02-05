import { db } from '@/lib/drizzle';
import { kilocode_users, microdollar_usage } from '@/db/schema';
import { sql, isNull, gte, inArray, notInArray, and, isNotNull } from 'drizzle-orm';

/**
 * Phase 1: Tag eligible inactive users into the 'cli-v1-rollout' cohort.
 *
 * Eligible = non-blocked users who have used Kilo before but not in the last 30 days.
 *
 * This script does cheap SQL writes (UPDATE cohorts jsonb field) and does NOT
 * grant any credits. Phase 2 (grant script) reads the cohort and grants credits.
 *
 * Usage:
 *   pnpm script src/scripts/d2025-02-04_cli-v1-rollout-cohort.ts           # dry run
 *   pnpm script src/scripts/d2025-02-04_cli-v1-rollout-cohort.ts --apply   # apply
 */

const isDryRun = !process.argv.includes('--apply');
const INACTIVE_DAYS = 30;
const COHORT_NAME = 'cli-v1-rollout';

async function run() {
  console.log('Phase 1: Tagging inactive users into cohort...\n');

  if (isDryRun) {
    console.log('DRY RUN MODE - No changes will be made');
    console.log('Run with --apply flag to write cohort tags\n');
  }

  const cutoff = new Date(Date.now() - INACTIVE_DAYS * 24 * 60 * 60 * 1000);

  // Users active in last 30 days
  console.log(`Fetching recently active user IDs (last ${INACTIVE_DAYS} days)...`);
  const recentlyActiveRows = await db
    .selectDistinct({ userId: microdollar_usage.kilo_user_id })
    .from(microdollar_usage)
    .where(gte(microdollar_usage.created_at, cutoff.toISOString()));

  const recentlyActiveIds = recentlyActiveRows.map(r => r.userId);
  console.log(`Found ${recentlyActiveIds.length} recently active users to EXCLUDE`);

  // Users who have ever used Kilo
  console.log('Fetching all users who have ever used Kilo...');
  const everUsedRows = await db
    .selectDistinct({ userId: microdollar_usage.kilo_user_id })
    .from(microdollar_usage);

  const everUsedIds = everUsedRows.map(r => r.userId);
  console.log(`Found ${everUsedIds.length} users who have ever used Kilo`);

  // Eligible = ever used, not recently active, not blocked, not already in cohort
  // Do this as a single UPDATE with subquery conditions
  const now = Date.now();

  if (isDryRun) {
    // Count eligible users without writing
    const eligible = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(
        and(
          isNull(kilocode_users.blocked_reason),
          inArray(kilocode_users.id, everUsedIds),
          recentlyActiveIds.length > 0
            ? notInArray(kilocode_users.id, recentlyActiveIds)
            : undefined,
          sql`NOT (${kilocode_users.cohorts} ? ${COHORT_NAME})`
        )
      );

    console.log(`\nWould tag ${eligible.length} users into cohort '${COHORT_NAME}'`);
  } else {
    // Batch the update to avoid massive single transaction
    // Process in chunks of everUsedIds since that's the IN clause
    const BATCH_SIZE = 5000;
    let totalTagged = 0;

    for (let i = 0; i < everUsedIds.length; i += BATCH_SIZE) {
      const batch = everUsedIds.slice(i, i + BATCH_SIZE);

      const result = await db
        .update(kilocode_users)
        .set({
          cohorts: sql`${kilocode_users.cohorts} || jsonb_build_object(${COHORT_NAME}, ${now})`,
        })
        .where(
          and(
            isNull(kilocode_users.blocked_reason),
            inArray(kilocode_users.id, batch),
            recentlyActiveIds.length > 0
              ? notInArray(kilocode_users.id, recentlyActiveIds)
              : undefined,
            sql`NOT (${kilocode_users.cohorts} ? ${COHORT_NAME})`
          )
        )
        .returning({ id: kilocode_users.id });

      totalTagged += result.length;
      console.log(
        `Batch ${Math.floor(i / BATCH_SIZE) + 1}: tagged ${result.length} users (total: ${totalTagged})`
      );
    }

    console.log(`\nDone. Tagged ${totalTagged} users into cohort '${COHORT_NAME}'`);
  }
}

run()
  .then(() => {
    console.log('\nScript completed successfully');
    process.exit(0);
  })
  .catch(error => {
    console.error('\nScript failed:', error);
    process.exit(1);
  });
