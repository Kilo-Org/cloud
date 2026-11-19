/**
 * Backfill script for free_trial_end_at column
 *
 * This script populates free_trial_end_at for organizations whose trial was granted
 * (trial_granted = true) and that have a null value. It sets free_trial_end_at to
 * created_at + 14 days for those organizations only. Organizations created without a
 * trial (trial_granted = false and a null free_trial_end_at) are left untouched.
 *
 * Usage:
 *   pnpm script src/scripts/db/backfill-free-trial-end-at.ts
 */

import { db } from '@kilocode/web-shared/lib/drizzle';
import { organizations } from '@kilocode/db/schema';
import { and, eq, isNull, sql } from 'drizzle-orm';

// Only a granted trial with a missing end date is a row this backfill owns.
const needsBackfill = and(
  eq(organizations.trial_granted, true),
  isNull(organizations.free_trial_end_at)
);

export async function run() {
  try {
    // Count organizations with a granted trial and a null free_trial_end_at
    const nullCountResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(organizations)
      .where(needsBackfill);

    const nullCount = nullCountResult[0]?.count ?? 0;

    if (nullCount === 0) {
      console.log('✓ No organizations with a granted trial are missing free_trial_end_at.');
      return;
    }

    // Populate free_trial_end_at for organizations with a granted trial and a null value
    const updateResult = await db
      .update(organizations)
      .set({
        free_trial_end_at: sql`${organizations.created_at} + INTERVAL '14 days'`,
      })
      .where(needsBackfill);

    // Verify backfill of the rows this script owns
    const verifyResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(organizations)
      .where(needsBackfill);

    const remainingNulls = verifyResult[0]?.count ?? 0;
    if (remainingNulls > 0) {
      throw new Error(
        `Backfill incomplete: ${remainingNulls} organizations with a granted trial still have null free_trial_end_at`
      );
    }

    console.log(
      `✓ Backfilled free_trial_end_at for ${updateResult.rowCount ?? 0} organizations with a granted trial`
    );
  } catch (error) {
    console.error('\n✗ Backfill failed:', error);
    process.exit(1);
  } finally {
    await db.$client.end();
  }
}
