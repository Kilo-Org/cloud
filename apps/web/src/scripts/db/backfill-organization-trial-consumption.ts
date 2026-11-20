/**
 * Stamp the per-user trial record for organizations that granted a trial without
 * stamping their creator.
 *
 * `createOrganization` stamps `kilocode_users.organization_trial_consumed_at` in the same
 * transaction that grants a trial, and migration `0376_crazy_xavin` backfills the history
 * that predates the column. One gap remains: migrations apply in `db-gate` while the
 * previous app build still serves traffic (`promote-app` needs `db-gate`), so an
 * organization the previous build creates in that window grants its creator a trial and
 * leaves the creator's record unset. This script sets that record for those users after
 * the promotion, so the per-user record stays complete.
 *
 * Run this after the promotion. It is safe to repeat: it only touches users whose record
 * is still null and who created an organization carrying a granted trial, so a second run
 * finds no rows.
 *
 * Usage:
 *   pnpm --filter web script:run db backfill-organization-trial-consumption
 *
 * The predicate must stay identical to the backfill in
 * `packages/db/src/migrations/0376_crazy_xavin.sql`.
 */

import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { sql } from 'drizzle-orm';

/**
 * Mark every user who created an organization carrying a granted trial as having used
 * their one trial, and return the number of user rows stamped.
 */
export async function stampOrganizationTrialConsumption(tx: DrizzleTransaction): Promise<number> {
  const result = await tx.execute(sql`
    UPDATE "kilocode_users"
    SET "organization_trial_consumed_at" = now()
    WHERE "organization_trial_consumed_at" IS NULL
      AND "id" = ANY (
        ARRAY(
          SELECT "created_by_kilo_user_id"
          FROM "organizations"
          WHERE "trial_granted" = true
            AND "created_by_kilo_user_id" IS NOT NULL
        )
      )
  `);
  return result.rowCount ?? 0;
}

export async function run(): Promise<void> {
  // One transaction, so `SET LOCAL` reaches the same connection as the UPDATE and the
  // row locks are released when it commits. The server's default statement timeout is
  // sized for interactive queries and would cancel a write of this size on the
  // production table, and the default lock timeout would abort the run on a transient
  // wait for a creator row a live creation transaction holds. Mirrors the migration.
  const stamped = await db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout = 0`);
    await tx.execute(sql`SET LOCAL lock_timeout = 0`);
    return stampOrganizationTrialConsumption(tx);
  });

  console.log(
    `✓ Stamped organization_trial_consumed_at on ${stamped} user row(s) that created a granted-trial organization`
  );
}
