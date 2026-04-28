import { getWorkerDb } from '@kilocode/db';
import { kiloclaw_instances } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

/**
 * Returns a human-readable label for the sandbox, or a fallback string if
 * the instance row is not found. Used to compose push notification titles.
 */
export async function fetchSandboxLabel(env: Env, sandboxId: string): Promise<string> {
  const db = getWorkerDb(env.HYPERDRIVE.connectionString);
  const [row] = await db
    .select({ name: kiloclaw_instances.name })
    .from(kiloclaw_instances)
    .where(eq(kiloclaw_instances.sandbox_id, sandboxId))
    .limit(1);
  return row?.name ?? `Agent ${sandboxId.slice(0, 8)}`;
}
