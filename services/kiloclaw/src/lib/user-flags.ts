/**
 * Read per-user feature flags from Postgres.
 *
 * `kiloclaw_early_access` is opt-in early-access for all of a user's KiloClaw
 * instances. When true, the rollout selector treats them as in-cohort for any
 * active candidate image (regardless of bucket). Used for staff dogfooding and
 * designated beta testers. Pin overrides still win.
 */
import { getWorkerDb } from '@kilocode/db/client';
import { kilocode_users, kiloclaw_instances } from '@kilocode/db';
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

/**
 * Resolve the Early Access flag for the user who owns the given instance.
 * The platform `/versions/latest` endpoint uses this so callers cannot
 * forge Early Access by passing it as a query param.
 *
 * Returns false when the instance row doesn't exist (e.g. provisioning
 * race) or the user has the flag disabled.
 */
export async function lookupKiloclawEarlyAccessByInstanceId(
  hyperdriveConnectionString: string,
  instanceId: string
): Promise<boolean> {
  const db = getWorkerDb(hyperdriveConnectionString);
  const [row] = await db
    .select({ early_access: kilocode_users.kiloclaw_early_access })
    .from(kiloclaw_instances)
    .innerJoin(kilocode_users, eq(kiloclaw_instances.user_id, kilocode_users.id))
    .where(eq(kiloclaw_instances.id, instanceId))
    .limit(1);
  return row?.early_access ?? false;
}
