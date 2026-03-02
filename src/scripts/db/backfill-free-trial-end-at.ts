/**
 * Backfill script for free_trial_end_at column
 *
 * This script populates free_trial_end_at for existing organizations that have null values.
 * It sets free_trial_end_at to created_at + 30 days for all organizations where it's currently null.
 *
 * Usage:
 *   pnpm script src/scripts/db/backfill-free-trial-end-at.ts
 */

import { db } from '@/lib/drizzle';
import { organizations } from '@kilocode/db/schema';
import { sql, isNull } from 'drizzle-orm';

export async function run() {
  try {
    // Count organizations with null free_trial_end_at
    const nullCountResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(organizations)
      .where(isNull(organizations.free_trial_end_at));

    const nullCount = nullCountResult[0]?.count ?? 0;

    if (nullCount === 0) {
      console.log('✓ All organizations already have free_trial_end_at set.');
      return;
    }

    // Populate free_trial_end_at for organizations with null values
    const updateResult = await db
      .update(organizations)
      .set({
        free_trial_end_at: sql`${organizations.created_at} + INTERVAL '30 days'`,
      })
      .where(isNull(organizations.free_trial_end_at));

    // Verify backfill
    const verifyResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(organizations)
      .where(isNull(organizations.free_trial_end_at));

    const remainingNulls = verifyResult[0]?.count ?? 0;
    if (remainingNulls > 0) {
      throw new Error(
        `Backfill incomplete: ${remainingNulls} organizations still have null free_trial_end_at`
      );
    }

    console.log(`✓ Backfilled free_trial_end_at for ${updateResult.rowCount ?? 0} organizations`);
  } catch (error) {
    console.error('\n✗ Backfill failed:', error);
    process.exit(1);
  } finally {
    await db.$client.end();
  }
}
