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
