import { db } from '@/lib/drizzle';
import { kilocode_users, microdollar_usage, type User } from '@/db/schema';
import { isNull, gt, and, gte } from 'drizzle-orm';
import { grantCreditForCategory } from '@/lib/promotionalCredits';
import pLimit from 'p-limit';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const isDryRun = !process.argv.includes('--apply');

// Resume support: If script crashes, you can resume from the last processed user ID
// Example: pnpm script src/scripts/d2025-02-04_cli-v1-rollout.ts --resume=user-abc-123
const resumeFromArg = process.argv.find(arg => arg.startsWith('--resume='));
const RESUME_FROM_USER_ID = resumeFromArg ? resumeFromArg.split('=')[1] : null;

const BATCH_SIZE = 10;
const SLEEP_AFTER_BATCH_MS = 1000;
const CONCURRENT = 10;
const FETCH_BATCH_SIZE = 1000;
const INACTIVE_DAYS = 30;

type ProcessingStats = {
  processed: number;
  successful: number;
  skipped: number;
  skippedActive: number;
  skippedNeverUsed: number;
  failed: number;
};

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  console.log('Starting CLI V1 rollout credit distribution...');
  console.log('Credit: $1 with 7-day expiry for inactive users (no usage in last 30 days)\n');

  if (isDryRun) {
    console.log('DRY RUN MODE - No changes will be made to the database');
    console.log('Run with --apply flag to actually grant credits\n');
  }

  const scriptStartTime = Date.now();

  // Step 1: Pre-compute recently active users (last 30 days)
  console.log(`Fetching recently active user IDs (last ${INACTIVE_DAYS} days)...`);
  const cutoff = new Date(Date.now() - INACTIVE_DAYS * 24 * 60 * 60 * 1000);

  const recentlyActiveRows = await db
    .selectDistinct({ userId: microdollar_usage.kilo_user_id })
    .from(microdollar_usage)
    .where(gte(microdollar_usage.created_at, cutoff.toISOString()));

  const recentlyActiveSet = new Set(recentlyActiveRows.map(r => r.userId));
  console.log(`Found ${recentlyActiveSet.size} recently active users to EXCLUDE`);

  // Step 2: Pre-compute users who have ever used Kilo
  console.log('Fetching all users who have ever used Kilo...');
  const everUsedRows = await db
    .selectDistinct({ userId: microdollar_usage.kilo_user_id })
    .from(microdollar_usage);

  const everUsedSet = new Set(everUsedRows.map(r => r.userId));
  console.log(`Found ${everUsedSet.size} users who have ever used Kilo`);

  // Eligible = ever used - recently active
  const eligibleCount = [...everUsedSet].filter(id => !recentlyActiveSet.has(id)).length;
  console.log(`Estimated eligible inactive users: ${eligibleCount}\n`);

  const stats: ProcessingStats = {
    processed: 0,
    successful: 0,
    skipped: 0,
    skippedActive: 0,
    skippedNeverUsed: 0,
    failed: 0,
  };

  const failedUserIds: string[] = [];
  const limit = pLimit(CONCURRENT);
  let globalBatchNumber = 0;
  let lastUserId: string | null = RESUME_FROM_USER_ID;
  let hasMore = true;

  if (RESUME_FROM_USER_ID) {
    console.log(`RESUMING from user ID: ${RESUME_FROM_USER_ID}\n`);
  }

  console.log('Starting cursor-based pagination...\n');

  // Step 3: Cursor-paginated loop over non-blocked users
  while (hasMore) {
    const users: User[] = await db.query.kilocode_users.findMany({
      where: lastUserId
        ? and(isNull(kilocode_users.blocked_reason), gt(kilocode_users.id, lastUserId))
        : isNull(kilocode_users.blocked_reason),
      orderBy: (kilocode_users, { asc }) => [asc(kilocode_users.id)],
      limit: FETCH_BATCH_SIZE,
    });

    if (users.length === 0) {
      hasMore = false;
      break;
    }

    lastUserId = users[users.length - 1].id;
    hasMore = users.length === FETCH_BATCH_SIZE;

    console.log(`\nFetched ${users.length} users from database`);

    for (let i = 0; i < users.length; i += BATCH_SIZE) {
      const batch = users.slice(i, Math.min(i + BATCH_SIZE, users.length));
      globalBatchNumber++;

      console.log(
        `\nProcessing batch ${globalBatchNumber} (${batch.length} users, total processed: ${stats.processed})...`
      );

      const batchPromises = batch.map(user =>
        limit(async () => {
          stats.processed++;

          // Skip users who never used Kilo
          if (!everUsedSet.has(user.id)) {
            stats.skippedNeverUsed++;
            return;
          }

          // Skip users who are recently active
          if (recentlyActiveSet.has(user.id)) {
            stats.skippedActive++;
            return;
          }

          try {
            if (isDryRun) {
              stats.successful++;
              if (stats.successful <= 100) {
                console.log(
                  `  [DRY RUN] Would grant to: ${user.id} (${user.google_user_email})`
                );
              }
              return;
            }

            const result = await grantCreditForCategory(user, {
              credit_category: 'cli-v1-rollout',
              counts_as_selfservice: false,
            });

            if (!result.success) {
              const alreadyApplied = result.message.includes('already been applied');

              if (alreadyApplied) {
                stats.skipped++;
                if (stats.skipped <= 100) {
                  console.log(
                    `  Skipped ${user.id} (${user.google_user_email}): Already applied`
                  );
                }
              } else {
                stats.failed++;
                failedUserIds.push(user.id);
                console.log(
                  `  Failed for ${user.id} (${user.google_user_email}): ${result.message}`
                );
              }
            } else {
              stats.successful++;
              if (stats.successful <= 100 || stats.successful % 1000 === 0) {
                console.log(
                  `  Granted to: ${user.id} (${user.google_user_email}) [#${stats.successful}]`
                );
              }
            }
          } catch (error) {
            stats.failed++;
            const errorMessage = error instanceof Error ? error.message : String(error);
            failedUserIds.push(user.id);
            console.error(
              `  Error processing ${user.id} (${user.google_user_email}):`,
              errorMessage
            );
          }
        })
      );

      await Promise.all(batchPromises);

      const elapsedSeconds = (Date.now() - scriptStartTime) / 1000;
      const usersPerSecond = stats.processed / elapsedSeconds;

      console.log(`\nProgress: ${stats.processed} users processed`);
      console.log(`   Successful: ${stats.successful}`);
      console.log(`   Skipped (already applied): ${stats.skipped}`);
      console.log(`   Skipped (recently active): ${stats.skippedActive}`);
      console.log(`   Skipped (never used Kilo): ${stats.skippedNeverUsed}`);
      console.log(`   Failed: ${stats.failed}`);
      console.log(`   Rate: ${usersPerSecond.toFixed(2)} users/sec`);
      console.log(`   Last user ID: ${lastUserId}`);
      console.log(`   To resume from this point: --resume=${lastUserId}`);

      if (hasMore || i + BATCH_SIZE < users.length) {
        await sleep(SLEEP_AFTER_BATCH_MS);
      }
    }
  }

  // Final report
  const totalElapsedSeconds = (Date.now() - scriptStartTime) / 1000;
  console.log('\n' + '='.repeat(60));
  console.log('Rollout completed!');
  console.log('='.repeat(60));
  console.log(`\nFinal Statistics:`);
  console.log(`   Total processed: ${stats.processed}`);
  console.log(`   Successful: ${stats.successful}`);
  console.log(`   Skipped (already applied): ${stats.skipped}`);
  console.log(`   Skipped (recently active): ${stats.skippedActive}`);
  console.log(`   Skipped (never used Kilo): ${stats.skippedNeverUsed}`);
  console.log(`   Failed: ${stats.failed}`);
  console.log(`   Total time: ${totalElapsedSeconds.toFixed(1)}s`);
  console.log(`   Average rate: ${(stats.processed / totalElapsedSeconds).toFixed(2)} users/sec`);

  if (isDryRun) {
    console.log('\nThis was a DRY RUN. No actual changes were made.');
    console.log('To apply changes, run with --apply flag');
  } else {
    console.log(`\nTotal credits granted: $${stats.successful.toFixed(2)}`);
  }

  if (failedUserIds.length > 0) {
    const logFileName = `failed-users-cli-v1-rollout-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    const logFilePath = path.join(process.cwd(), logFileName);
    const logContent = failedUserIds.join('\n') + '\n';

    await fs.writeFile(logFilePath, logContent, 'utf-8');
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
