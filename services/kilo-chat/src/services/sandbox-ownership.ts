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
