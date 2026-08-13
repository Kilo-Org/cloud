// Written alongside every read-through value so an in-place rewrite can keep
// the original expiry rather than pushing it forward.
export type KvReadThroughMetadata = { writtenAt: number };

// Generic read-through cache on top of a KV namespace.
// On KV hit: parse+validate; corrupt values are treated as misses.
// On miss: fetch from origin; write to KV with expirationTtl on success.
// Origin null → no KV write; origin throw → propagates to caller.
export async function kvReadThrough<T>(options: {
  kv: KVNamespace;
  key: string;
  ttlSeconds: number;
  fetchOrigin: () => Promise<T | null>;
  parse: (raw: string) => T | null;
  serialize?: (value: T) => string;
}): Promise<T | null> {
  const { kv, key, ttlSeconds, fetchOrigin, parse, serialize = JSON.stringify } = options;

  const raw = await kv.get(key);
  if (raw !== null) {
    const parsed = parse(raw);
    if (parsed !== null) {
      return parsed;
    }
    console.warn(JSON.stringify({ event: 'kv_read_through_corrupt', key }));
  }

  // Miss (or corrupt value treated as miss): fetch from origin.
  const value = await fetchOrigin();
  if (value === null) {
    return null;
  }

  // Awaited: an unawaited promise without waitUntil may be cancelled when the
  // request ends, silently dropping the cache write. A put failure must not
  // discard the value we already fetched, so it only warns.
  // `writtenAt` stamps when this value was first built, so a caller that
  // rewrites the key in place can hold the original expiry instead of
  // restarting the TTL.
  await kv
    .put(key, serialize(value), {
      expirationTtl: ttlSeconds,
      metadata: { writtenAt: Date.now() } satisfies KvReadThroughMetadata,
    })
    .catch((error: unknown) =>
      console.warn(
        JSON.stringify({ event: 'kv_read_through_put_failed', key, error: String(error) })
      )
    );
  return value;
}
