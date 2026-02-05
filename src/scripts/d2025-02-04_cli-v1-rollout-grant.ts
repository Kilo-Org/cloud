import { db } from '@/lib/drizzle';
import { kilocode_users, type User } from '@/db/schema';
import { sql, gt, and } from 'drizzle-orm';
import { grantCreditForCategory } from '@/lib/promotionalCredits';
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

const COHORT_NAME = 'cli-v1-rollout';

export type GrantCohortCreditsResult = {
  granted: number;
  skipped: number;
  failed: number;
  failedUserIds: string[];
};

export async function grantCreditsToCohort(options: {
  cohortName: string;
  creditCategory: string;
}): Promise<GrantCohortCreditsResult> {
  let granted = 0;
  let skipped = 0;
  let failed = 0;
  const failedUserIds: string[] = [];

  let lastUserId: string | null = null;
  let hasMore = true;

  while (hasMore) {
    const cohortFilter = sql`${kilocode_users.cohorts} ? ${options.cohortName}`;
    const users: User[] = await db.query.kilocode_users.findMany({
      where: lastUserId ? and(cohortFilter, gt(kilocode_users.id, lastUserId)) : cohortFilter,
      orderBy: (kilocode_users, { asc }) => [asc(kilocode_users.id)],
      limit: 1000,
    });

    if (users.length === 0) {
      hasMore = false;
      break;
    }

    lastUserId = users[users.length - 1].id;
    hasMore = users.length === 1000;

    for (const user of users) {
      try {
        const result = await grantCreditForCategory(user, {
          credit_category: options.creditCategory,
          counts_as_selfservice: false,
        });

        if (!result.success) {
          if (result.message.includes('already been applied')) {
            skipped++;
          } else {
            failed++;
            failedUserIds.push(user.id);
          }
        } else {
          granted++;
        }
      } catch {
        failed++;
        failedUserIds.push(user.id);
      }
    }
  }

  return { granted, skipped, failed, failedUserIds };
}

async function run() {
  const isDryRun = !process.argv.includes('--apply');

  console.log('Phase 2: Granting credits to cohort members...');
  console.log(`Credit: $1 with 7-day expiry for users in cohort '${COHORT_NAME}'\n`);

  if (isDryRun) {
    console.log('DRY RUN MODE - No changes will be made');
    console.log('Run with --apply flag to grant credits\n');

    // In dry run, just count cohort members
    const cohortFilter = sql`${kilocode_users.cohorts} ? ${COHORT_NAME}`;
    const users = await db.query.kilocode_users.findMany({ where: cohortFilter });
    console.log(`Would grant credits to ${users.length} cohort members`);
    return;
  }

  const scriptStartTime = Date.now();
  const result = await grantCreditsToCohort({
    cohortName: COHORT_NAME,
    creditCategory: COHORT_NAME,
  });

  const totalSeconds = (Date.now() - scriptStartTime) / 1000;
  console.log('\n' + '='.repeat(60));
  console.log('Done!');
  console.log(`  Granted: ${result.granted}`);
  console.log(`  Already applied: ${result.skipped}`);
  console.log(`  Failed: ${result.failed}`);
  console.log(`  Time: ${totalSeconds.toFixed(1)}s`);

  if (result.failedUserIds.length > 0) {
    const logFileName = `failed-users-cli-v1-rollout-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    const logFilePath = path.join(process.cwd(), logFileName);
    await fs.writeFile(logFilePath, result.failedUserIds.join('\n') + '\n', 'utf-8');
    console.log(`\n${result.failedUserIds.length} failed user IDs written to: ${logFileName}`);
  }
}

// Only run if executed directly (not imported as a module for testing)
if (require.main === module || process.argv[1]?.endsWith('d2025-02-04_cli-v1-rollout-grant.ts')) {
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
