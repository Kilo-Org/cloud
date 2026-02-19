/**
 * Retroactively expires free credits for blocked users, one user at a time.
 *
 * For each blocked user with a positive balance:
 *  1. Calls retroactivelyExpireCreditsForUser to find all free, non-expiring
 *     credit transactions, stamp an expiry, and settle the balance.
 *  2. Prints the before/after balance so the operator can verify correctness.
 *
 * The script processes a single user per invocation by default. Pass --all to
 * process every blocked user sequentially (still one at a time, with output).
 *
 * Usage:
 *   pnpm script src/scripts/d2026-02-16_sum-blocked-users-balance.ts          # first eligible user
 *   pnpm script src/scripts/d2026-02-16_sum-blocked-users-balance.ts --all    # all eligible users
 */

import { and, isNotNull, gt } from 'drizzle-orm';
import { closeAllDrizzleConnections, db } from '@/lib/drizzle';
import { kilocode_users } from '@/db/schema';
import { retroactivelyExpireCreditsForUser } from '@/lib/creditExpiration';

async function fetchBlockedUsers() {
  return db
    .select({
      id: kilocode_users.id,
      microdollars_used: kilocode_users.microdollars_used,
      total_microdollars_acquired: kilocode_users.total_microdollars_acquired,
      next_credit_expiration_at: kilocode_users.next_credit_expiration_at,
      updated_at: kilocode_users.updated_at,
      google_user_email: kilocode_users.google_user_email,
    })
    .from(kilocode_users)
    .where(
      and(
        isNotNull(kilocode_users.blocked_reason),
        gt(kilocode_users.total_microdollars_acquired, kilocode_users.microdollars_used)
      )
    );
}

function formatUsd(microdollars: number): string {
  return `$${(microdollars / 1_000_000).toFixed(2)}`;
}

async function processUser(user: Awaited<ReturnType<typeof fetchBlockedUsers>>[number]) {
  const now = new Date();
  const result = await retroactivelyExpireCreditsForUser(user, now);

  if (!result) {
    console.log(`  ${user.google_user_email} — no free non-expiring credits, skipping`);
    return { skipped: true as const };
  }

  console.log(
    `  ${user.google_user_email} — balance before: ${formatUsd(result.balanceBefore)}, after: ${formatUsd(result.balanceAfter)}, expired: ${formatUsd(result.balanceBefore - result.balanceAfter)}`
  );
  return {
    skipped: false as const,
    email: user.google_user_email,
    ...result,
  };
}

async function main() {
  const processAll = process.argv.includes('--all');

  console.log('Fetching blocked users with positive balance...');
  const blockedUsers = await fetchBlockedUsers();
  console.log(`Found ${blockedUsers.length} blocked users with positive balance.\n`);

  if (blockedUsers.length === 0) return;

  const usersToProcess = processAll ? blockedUsers : [blockedUsers[0]];
  if (!processAll) {
    console.log('Processing first user only (pass --all to process all):\n');
  }

  let processedCount = 0;
  let totalExpired = 0;

  for (const user of usersToProcess) {
    const result = await processUser(user);
    if (!result.skipped) {
      processedCount++;
      totalExpired += result.balanceBefore - result.balanceAfter;
    }
  }

  console.log(`\n--- Summary ---`);
  console.log(`Users processed: ${processedCount}`);
  console.log(`Total expired: ${formatUsd(totalExpired)}`);
}

main()
  .catch(error => {
    console.error('Script failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await closeAllDrizzleConnections();
  });
