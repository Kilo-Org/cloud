/**
 * The ordered-key operations the bounded inserts below need. Both `Map` and
 * `Set` satisfy it, and `keys()` iterates in insertion order for both.
 */
type OrderedKeys<K> = {
  readonly size: number;
  keys(): IterableIterator<K>;
  delete(key: K): boolean;
};

/**
 * Evicts the oldest key of `records` that is neither the one just inserted nor
 * the protected one, once the record grows past `max`. At most one key is
 * dropped per insert: the record stays a little over `max` while a protected
 * key is its only other entry, and the next insert evicts the oldest entry
 * that is free again.
 */
function evictOldestOther<K>(
  records: OrderedKeys<K>,
  inserted: K,
  max: number,
  protectedKey: K | null
): void {
  if (records.size <= max) return;
  for (const oldest of records.keys()) {
    if (oldest === inserted || oldest === protectedKey) continue;
    records.delete(oldest);
    return;
  }
}

/**
 * Sets `key` as the newest entry of `map`, evicting the oldest entry once `map`
 * grows past `max`. Deleting first moves a re-set key to the end of the
 * insertion order the eviction reads, so a refreshed key is never the oldest.
 */
export function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

/**
 * Sets `key` as the newest entry of `map` and evicts the oldest entry that is
 * neither `key` nor `protectedKey`, once `map` grows past `max`. A caller that
 * keeps live state in a record entry — the active session's record — passes it
 * as `protectedKey` so the bound never drops an entry a reader still holds.
 */
export function setBoundedKeeping<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  max: number,
  protectedKey: K | null
): void {
  map.delete(key);
  map.set(key, value);
  evictOldestOther(map, key, max, protectedKey);
}

/**
 * Adds `key` as the newest entry of `set`, with the same protected-entry rule
 * as `setBoundedKeeping`.
 */
export function addBoundedKeeping<K>(
  set: Set<K>,
  key: K,
  max: number,
  protectedKey: K | null
): void {
  set.delete(key);
  set.add(key);
  evictOldestOther(set, key, max, protectedKey);
}
