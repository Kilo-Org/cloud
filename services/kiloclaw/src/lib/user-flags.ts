/**
 * Read per-user feature flags from Postgres.
 *
 * `kiloclaw_early_access` is opt-in early-access for all of a user's KiloClaw
 * instances. When true, the rollout selector treats them as in-cohort for any
 * active candidate image (regardless of bucket). Used for staff dogfooding and
 * designated beta testers. Pin overrides still win.
 */
import { getWorkerDb } from '@kilocode/db/client';
import { kilocode_users } from '@kilocode/db';
import { eq } from 'drizzle-orm';

export async function lookupKiloclawEarlyAccess(
  hyperdriveConnectionString: string,
  userId: string
): Promise<boolean> {
  const db = getWorkerDb(hyperdriveConnectionString);
  const [row] = await db
    .select({ early_access: kilocode_users.kiloclaw_early_access })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId))
    .limit(1);
  return row?.early_access ?? false;
}

export async function setKiloclawEarlyAccess(
  hyperdriveConnectionString: string,
  userId: string,
  value: boolean
): Promise<boolean> {
  const db = getWorkerDb(hyperdriveConnectionString);
  const result = await db
    .update(kilocode_users)
    .set({ kiloclaw_early_access: value })
    .where(eq(kilocode_users.id, userId))
    .returning({ id: kilocode_users.id });
  return result.length > 0;
}
