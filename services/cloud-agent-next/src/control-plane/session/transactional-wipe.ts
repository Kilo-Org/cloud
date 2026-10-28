import { z } from 'zod';

/** The tombstone a wipe keeps so a deleted issuer can resolve through a survivor. */
export const wipeLocatorSchema = z
  .object({
    version: z.literal(1),
    sandboxId: z.string().min(1),
    scopeId: z.string().min(1),
    allocationId: z.string().min(1),
    wrapperInstanceId: z.string().min(1),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type WipeLocator = z.infer<typeof wipeLocatorSchema>;

/** Parses a stored locator and reports whether its handle lease already passed. */
export function parseWipeLocator(
  raw: unknown,
  now: number
): { locator: WipeLocator | null; expired: boolean } {
  const parsed = wipeLocatorSchema.safeParse(raw);
  if (!parsed.success) return { locator: null, expired: false };
  return { locator: parsed.data, expired: parsed.data.expiresAt <= now };
}

/**
 * The transactional core of the Session DO's wipe for an issuer that had an
 * accepted scope handle. Kept free of Durable Object imports so the rollback
 * contract can be tested directly: `transactionSync` must roll back every KV
 * and table write when the callback throws.
 */
export type WipeTransactionStorage = {
  transactionSync<T>(callback: () => T): T;
  kv: {
    put(key: string, value: unknown): void;
    delete(key: string): boolean;
    list(): Iterable<[string, unknown]>;
  };
};

export type TransactionalWipeInput = {
  storage: WipeTransactionStorage;
  locatorKey: string;
  generationKey: string;
  generation: number;
  locator: unknown;
  /** Deletes the two application tables through Drizzle (synchronous `.run()`). */
  deleteApplicationTables: () => void;
};

/**
 * Writes the locator, deletes the application tables, deletes every other KV
 * key, and restores the generation — all in one synchronous transaction. The
 * locator and generation survive; the schema and `__drizzle_migrations`
 * bookkeeping are untouched because the tables are not dropped.
 */
export function runTransactionalWipe(input: TransactionalWipeInput): void {
  input.storage.transactionSync(() => {
    input.storage.kv.put(input.locatorKey, input.locator);
    input.deleteApplicationTables();
    const keys: string[] = [];
    for (const [key] of input.storage.kv.list()) keys.push(key);
    for (const key of keys) {
      if (key === input.locatorKey || key === input.generationKey) continue;
      input.storage.kv.delete(key);
    }
    input.storage.kv.put(input.generationKey, input.generation);
  });
}
