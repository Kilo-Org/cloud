import type { z } from 'zod';

/**
 * Key material a Durable Object generates for itself lives in its KV storage, not in SQL rows: a
 * Workers trace records each SQL statement's bound values, while a storage get or put records the
 * key name only (https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/).
 *
 * `legacy` reads the SQL row an earlier revision wrote, and `dropLegacy` deletes it (statements
 * that bind only the row id). A legacy value is moved to KV storage once and its row deleted.
 */
export async function loadOrCreateKey<T>(input: {
  storage: DurableObjectStorage;
  name: string;
  schema: z.ZodType<T>;
  legacy: () => T | null;
  dropLegacy: () => void;
  create: () => T | Promise<T>;
}): Promise<T> {
  const stored: unknown = await input.storage.get(input.name);
  if (stored !== undefined) {
    // A move interrupted between the put and the delete leaves the row; finish it.
    if (input.legacy() !== null) input.dropLegacy();
    return input.schema.parse(stored);
  }
  const legacy = input.legacy();
  const value = legacy ?? (await input.create());
  await input.storage.put(input.name, value);
  if (legacy !== null) input.dropLegacy();
  return value;
}
