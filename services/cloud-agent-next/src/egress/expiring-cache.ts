/**
 * A bounded in-memory map whose entries expire. When the map is full, the
 * oldest written entry goes first.
 */
export function createExpiringCache<V>(maxEntries: number) {
  const entries = new Map<string, { value: V; expiresAt: number }>();
  return {
    get(key: string, now: number): V | undefined {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      if (entry.expiresAt > now) return entry.value;
      entries.delete(key);
      return undefined;
    },
    set(key: string, value: V, expiresAt: number): void {
      entries.delete(key);
      entries.set(key, { value, expiresAt });
      for (const oldest of entries.keys()) {
        if (entries.size <= maxEntries) break;
        entries.delete(oldest);
      }
    },
    get size(): number {
      return entries.size;
    },
  };
}

export type ExpiringCache<V> = ReturnType<typeof createExpiringCache<V>>;
