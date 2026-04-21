import { getWorkerDb } from '@kilocode/db';
import { kiloclaw_instances } from '@kilocode/db/schema';
import { and, eq, isNull } from 'drizzle-orm';

/** Returns true if the user owns an active (non-destroyed) instance for the given sandbox. */
export async function userOwnsSandbox(
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

/**
 * Returns the user_id of the sandbox owner (active, non-destroyed instance),
 * or null if no active instance exists for the given sandboxId.
 */
export async function getSandboxOwner(
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
