import { db } from '@/lib/drizzle';
import { kilocode_users, type User } from '@/db/schema';
import { sql, gt, and } from 'drizzle-orm';
import { grantCreditForCategory } from '@/lib/promotionalCredits';
import pLimit from 'p-limit';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Phase 2: Grant $1 credits to all users in the 'cli-v1-rollout' cohort.
 *
 * Reads users tagged by Phase 1 (cohort script) and grants them credits.
 * Idempotent — safe to re-run; users who already received the credit are skipped.
 *
 * Usage:
 *   pnpm script src/scripts/d2025-02-04_cli-v1-rollout-grant.ts           # dry run
 *   pnpm script src/scripts/d2025-02-04_cli-v1-rollout-grant.ts --apply   # apply
 */

const isDryRun = !process.argv.includes('--apply');

const BATCH_SIZE = 100;
const SLEEP_AFTER_BATCH_MS = 1000;
const CONCURRENT = 10;
const FETCH_BATCH_SIZE = 1000;
const COHORT_NAME = 'cli-v1-rollout';

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  console.log('Phase 2: Granting credits to cohort members...');
  console.log(`Credit: $1 with 7-day expiry for users in cohort '${COHORT_NAME}'\n`);

  if (isDryRun) {
    console.log('DRY RUN MODE - No changes will be made');
    console.log('Run with --apply flag to grant credits\n');
  }

  const scriptStartTime = Date.now();
  let processed = 0;
  let successful = 0;
  let skipped = 0;
  let failed = 0;
  const failedUserIds: string[] = [];
  const limit = pLimit(CONCURRENT);
  let lastUserId: string | null = null;
  let hasMore = true;

  // Cursor-paginated loop over cohort members
  while (hasMore) {
    const cohortFilter = sql`${kilocode_users.cohorts} ? ${COHORT_NAME}`;
    const users: User[] = await db.query.kilocode_users.findMany({
      where: lastUserId
        ? and(cohortFilter, gt(kilocode_users.id, lastUserId))
        : cohortFilter,
      orderBy: (kilocode_users, { asc }) => [asc(kilocode_users.id)],
      limit: FETCH_BATCH_SIZE,
    });

    if (users.length === 0) {
      hasMore = false;
      break;
    }

    lastUserId = users[users.length - 1].id;
    hasMore = users.length === FETCH_BATCH_SIZE;

    console.log(`Fetched ${users.length} cohort members from database`);

    for (let i = 0; i < users.length; i += BATCH_SIZE) {
      const batch = users.slice(i, Math.min(i + BATCH_SIZE, users.length));

      const batchPromises = batch.map(user =>
        limit(async () => {
          processed++;

          try {
            if (isDryRun) {
              successful++;
              if (successful <= 100) {
                console.log(`  [DRY RUN] Would grant to: ${user.id} (${user.google_user_email})`);
              }
              return;
            }

            const result = await grantCreditForCategory(user, {
              credit_category: 'cli-v1-rollout',
              counts_as_selfservice: false,
            });

            if (!result.success) {
              if (result.message.includes('already been applied')) {
                skipped++;
              } else {
                failed++;
                failedUserIds.push(user.id);
                console.log(`  Failed for ${user.id}: ${result.message}`);
              }
            } else {
              successful++;
              if (successful <= 100 || successful % 1000 === 0) {
                console.log(`  Granted to: ${user.id} [#${successful}]`);
              }
            }
          } catch (error) {
            failed++;
            failedUserIds.push(user.id);
            console.error(
              `  Error processing ${user.id}:`,
              error instanceof Error ? error.message : String(error)
            );
          }
        })
      );

      await Promise.all(batchPromises);

      const elapsedSeconds = (Date.now() - scriptStartTime) / 1000;
      console.log(
        `Progress: ${processed} processed, ${successful} granted, ${skipped} already applied, ${failed} failed (${(processed / elapsedSeconds).toFixed(1)} users/sec)`
      );

      if (hasMore || i + BATCH_SIZE < users.length) {
        await sleep(SLEEP_AFTER_BATCH_MS);
      }
    }
  }

  // Final report
  const totalSeconds = (Date.now() - scriptStartTime) / 1000;
  console.log('\n' + '='.repeat(60));
  console.log('Done!');
  console.log(`  Processed: ${processed}`);
  console.log(`  Granted: ${successful}`);
  console.log(`  Already applied: ${skipped}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Time: ${totalSeconds.toFixed(1)}s`);

  if (isDryRun) {
    console.log('\nThis was a DRY RUN. No actual changes were made.');
  }

  if (failedUserIds.length > 0) {
    const logFileName = `failed-users-cli-v1-rollout-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    const logFilePath = path.join(process.cwd(), logFileName);
    await fs.writeFile(logFilePath, failedUserIds.join('\n') + '\n', 'utf-8');
    console.log(`\n${failedUserIds.length} failed user IDs written to: ${logFileName}`);
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
