import type { z } from 'zod';

/**
 * Key material a Durable Object generates for itself lives in its KV storage, not in SQL rows: a
 * Workers trace records each SQL statement's bound values, while a storage get or put records the
 * key name only (https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/).
 */
export async function loadOrCreateKey<T>(input: {
  storage: DurableObjectStorage;
  name: string;
  schema: z.ZodType<T>;
  create: () => T | Promise<T>;
}): Promise<T> {
  const stored: unknown = await input.storage.get(input.name);
  if (stored !== undefined) return input.schema.parse(stored);
  const value = await input.create();
  await input.storage.put(input.name, value);
  return value;
}
