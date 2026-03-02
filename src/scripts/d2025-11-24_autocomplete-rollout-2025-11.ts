import { db } from '@/lib/drizzle';
import { kilocode_users, type User } from '@kilocode/db/schema';
import { isNull, gt, and } from 'drizzle-orm';
import { grantCreditForCategory } from '@/lib/promotionalCredits';
import pLimit from 'p-limit';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const isDryRun = !process.argv.includes('--apply');

// Resume support: If script crashes, you can resume from the last processed user ID
// Example: pnpm script src/scripts/d2025-11-24_autocomplete-rollout-2025-11.ts --resume=user-abc-123
const resumeFromArg = process.argv.find(arg => arg.startsWith('--resume='));
const RESUME_FROM_USER_ID = resumeFromArg ? resumeFromArg.split('=')[1] : null;

// Rate limiting: Orb API limit is 30 req/sec for client.customers.credits.ledger.createEntryByExternalId
// We'll use 10 req/sec to maintain safety margin (67% buffer)
// Strategy: Process 10 users, always sleep 1 second - simple and predictable
// This ensures max 10 req/sec AND limits system load to prevent starving other processes
const BATCH_SIZE = 10; // Process exactly 10 users at a time
const SLEEP_AFTER_BATCH_MS = 1000; // Always sleep 1 second after each batch
const CONCURRENT_ORBS = 10; // Process all 10 in parallel
const FETCH_BATCH_SIZE = 1000; // Fetch 1000 users at a time from DB to avoid memory issues

type ProcessingStats = {
  processed: number;
  successful: number;
  skipped: number; // Already had the credit
  failed: number;
};

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  console.log('🚀 Starting autocomplete rollout credit distribution...');
  console.log('Credit: $1 with 30-day expiry for all non-abuser users\n');

  if (isDryRun) {
    console.log('🔍 DRY RUN MODE - No changes will be made to the database');
    console.log('Run with --apply flag to actually grant credits\n');
  }

  const scriptStartTime = Date.now();

  const stats: ProcessingStats = {
    processed: 0,
    successful: 0,
    skipped: 0,
    failed: 0,
  };

  // Track failed user IDs for logging to file
  const failedUserIds: string[] = [];

  // Set up rate limiting
  const limit = pLimit(CONCURRENT_ORBS);
  let globalBatchNumber = 0;
  let lastUserId: string | null = RESUME_FROM_USER_ID;
  let hasMore = true;

  if (RESUME_FROM_USER_ID) {
    console.log(`🔄 RESUMING from user ID: ${RESUME_FROM_USER_ID}\n`);
  }

  console.log('📊 Starting cursor-based pagination for 400k+ users...\n');

  // Process users with cursor-based pagination to avoid loading all 400k into memory
  while (hasMore) {
    // Fetch next batch of users from database
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

    // Update cursor for next iteration
    lastUserId = users[users.length - 1].id;
    hasMore = users.length === FETCH_BATCH_SIZE;

    console.log(`\n📥 Fetched ${users.length} users from database`);

    // Process this DB batch in smaller Orb API batches
    for (let i = 0; i < users.length; i += BATCH_SIZE) {
      const batch = users.slice(i, Math.min(i + BATCH_SIZE, users.length));
      globalBatchNumber++;

      console.log(
        `\n📦 Processing batch ${globalBatchNumber} (${batch.length} users, total processed: ${stats.processed})...`
      );

      // Process batch with rate limiting
      const batchPromises = batch.map(user =>
        limit(async () => {
          stats.processed++;

          try {
            if (isDryRun) {
              stats.successful++;
              // Only log first 100 users in dry run to avoid spam
              if (stats.successful <= 100) {
                console.log(
                  `  ✅ [DRY RUN] Would grant to: ${user.id} (${user.google_user_email})`
                );
              }
              return;
            }

            const result = await grantCreditForCategory(user, {
              credit_category: 'autocomplete-rollout-2025-11',
              counts_as_selfservice: false,
            });

            if (!result.success) {
              // Check if failure is because credit already applied (this is OK)
              const alreadyApplied = result.message.includes('already been applied');

              if (alreadyApplied) {
                stats.skipped++;
                // Don't log skips unless in first 100 for visibility
                if (stats.skipped <= 100) {
                  console.log(
                    `  ⏭️  Skipped ${user.id} (${user.google_user_email}): Already applied`
                  );
                }
              } else {
                // Real failure - track and log it
                stats.failed++;
                failedUserIds.push(user.id);
                console.log(
                  `  ❌ Failed for ${user.id} (${user.google_user_email}): ${result.message}`
                );
              }
            } else {
              stats.successful++;
              // Only log first 100 successes and every 1000th to reduce spam
              if (stats.successful <= 100 || stats.successful % 1000 === 0) {
                console.log(
                  `  ✅ Granted to: ${user.id} (${user.google_user_email}) [#${stats.successful}]`
                );
              }
            }
          } catch (error) {
            stats.failed++;
            const errorMessage = error instanceof Error ? error.message : String(error);
            failedUserIds.push(user.id);
            // Always log errors
            console.error(
              `  ❌ Error processing ${user.id} (${user.google_user_email}):`,
              errorMessage
            );
          }
        })
      );

      // Wait for batch to complete
      await Promise.all(batchPromises);

      // Progress report
      const elapsedSeconds = (Date.now() - scriptStartTime) / 1000;
      const usersPerSecond = stats.processed / elapsedSeconds;

      console.log(`\n📈 Progress: ${stats.processed} users processed`);
      console.log(`   ✅ Successful: ${stats.successful}`);
      console.log(`   ⏭️  Skipped: ${stats.skipped} (already had credit)`);
      console.log(`   ❌ Failed: ${stats.failed}`);
      console.log(`   ⏱️  Rate: ${usersPerSecond.toFixed(2)} users/sec (target: ≤10 req/sec)`);
      console.log(`   📍 Last user ID: ${lastUserId}`);
      console.log(`   🔄 To resume from this point: --resume=${lastUserId}`);

      // Always sleep 1 second after each batch for rate limiting and load management
      if (hasMore || i + BATCH_SIZE < users.length) {
        await sleep(SLEEP_AFTER_BATCH_MS);
      }
    }
  }

  // Final report
  const totalElapsedSeconds = (Date.now() - scriptStartTime) / 1000;
  console.log('\n' + '='.repeat(60));
  console.log('✅ Rollout completed!');
  console.log('='.repeat(60));
  console.log(`\n📊 Final Statistics:`);
  console.log(`   Total processed: ${stats.processed}`);
  console.log(`   Successful: ${stats.successful}`);
  console.log(`   Skipped: ${stats.skipped} (already had credit)`);
  console.log(`   Failed: ${stats.failed}`);
  console.log(`   Total time: ${totalElapsedSeconds.toFixed(1)}s`);
  console.log(`   Average rate: ${(stats.processed / totalElapsedSeconds).toFixed(2)} users/sec`);

  if (isDryRun) {
    console.log('\n🔍 This was a DRY RUN. No actual changes were made.');
    console.log('To apply changes, run with --apply flag');
  } else {
    console.log(`\n💰 Total credits granted: $${stats.successful.toFixed(2)}`);
  }

  // Write failed user IDs to log file if any (excludes "already applied" cases)
  if (failedUserIds.length > 0) {
    const logFileName = `failed-users-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    const logFilePath = path.join(process.cwd(), logFileName);

    // Simple format: one user ID per line
    const logContent = failedUserIds.join('\n') + '\n';

    await fs.writeFile(logFilePath, logContent, 'utf-8');
    console.log(`\n📝 ${failedUserIds.length} failed user IDs written to: ${logFileName}`);
    console.log(`   One user ID per line (excludes users who already had the credit)`);
  }
}

// Run the script
run()
  .then(() => {
    console.log('\n✨ Script completed successfully');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n❌ Script failed:', error);
    process.exit(1);
  });
