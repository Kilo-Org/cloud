import { getWorkerDb } from '@kilocode/db';
import { kiloclaw_instances } from '@kilocode/db/schema';
import { and, eq, isNull } from 'drizzle-orm';

async function queryOwnsSandbox(
  connectionString: string,
  userId: string,
  sandboxId: string
): Promise<boolean> {
  const db = getWorkerDb(connectionString);
  const rows = await db
    .select({ sandbox_id: kiloclaw_instances.sandbox_id })
    .from(kiloclaw_instances)
    .where(
      and(
        eq(kiloclaw_instances.sandbox_id, sandboxId),
        eq(kiloclaw_instances.user_id, userId),
        isNull(kiloclaw_instances.destroyed_at)
      )
    )
    .limit(1);
  return rows.length > 0;
}

async function querySandboxOwner(
  connectionString: string,
  sandboxId: string
): Promise<string | null> {
  const db = getWorkerDb(connectionString);
  const rows = await db
    .select({ user_id: kiloclaw_instances.user_id })
    .from(kiloclaw_instances)
    .where(
      and(eq(kiloclaw_instances.sandbox_id, sandboxId), isNull(kiloclaw_instances.destroyed_at))
    )
    .limit(1);
  return rows[0]?.user_id ?? null;
}

/**
 * Returns true if the user owns an active (non-destroyed) instance for the
 * given sandbox.
 */
export async function userOwnsSandbox(
  env: Env,
  userId: string,
  sandboxId: string
): Promise<boolean> {
  return await queryOwnsSandbox(env.HYPERDRIVE.connectionString, userId, sandboxId);
}

/**
 * Returns the user_id of the sandbox owner (active, non-destroyed instance),
 * or null if no active instance exists.
 */
export async function lookupSandboxOwnerUserId(
  env: Env,
  sandboxId: string
): Promise<string | null> {
  return await querySandboxOwner(env.HYPERDRIVE.connectionString, sandboxId);
}
