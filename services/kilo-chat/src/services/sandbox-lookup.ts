import { getWorkerDb } from '@kilocode/db/client';
import { kiloclaw_instances } from '@kilocode/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { LRUCache } from 'lru-cache';

const sandboxLabelCache = new LRUCache<string, string>({
  max: 500,
  ttl: 5 * 60 * 1000,
});

export function clearSandboxLabelCache(): void {
  sandboxLabelCache.clear();
}

export async function fetchSandboxLabel(
  hyperdriveConnectionString: string,
  sandboxId: string
): Promise<string> {
  const cached = sandboxLabelCache.get(sandboxId);
  if (cached) return cached;

  const db = getWorkerDb(hyperdriveConnectionString);
  const [row] = await db
    .select({ name: kiloclaw_instances.name })
    .from(kiloclaw_instances)
    .where(
      and(eq(kiloclaw_instances.sandbox_id, sandboxId), isNull(kiloclaw_instances.destroyed_at))
    )
    .limit(1);
  const label = row?.name ?? 'KiloClaw';
  sandboxLabelCache.set(sandboxId, label);
  return label;
}
