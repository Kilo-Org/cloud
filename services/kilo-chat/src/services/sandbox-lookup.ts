import { getWorkerDb } from '@kilocode/db/client';
import { kiloclaw_instances } from '@kilocode/db/schema';
import { and, eq, isNull } from 'drizzle-orm';

export async function fetchSandboxLabel(
  hyperdriveConnectionString: string,
  sandboxId: string
): Promise<string> {
  const db = getWorkerDb(hyperdriveConnectionString);
  const [row] = await db
    .select({ name: kiloclaw_instances.name })
    .from(kiloclaw_instances)
    .where(
      and(eq(kiloclaw_instances.sandbox_id, sandboxId), isNull(kiloclaw_instances.destroyed_at))
    )
    .limit(1);
  return row?.name ?? 'KiloClaw';
}
