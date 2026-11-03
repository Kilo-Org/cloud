/**
 * A module-level LRU keyed by a string, evicting the least-recently-used entries
 * once the total weight exceeds `maxWeight`.
 *
 * The weight defaults to the key's length. For the markdown parse caches the
 * markdown value is the key and its length is a close proxy for the memory an
 * entry costs, so one budget covers both the lexed tokens and the HTML split a
 * value produced. A caller whose cached value retains more than its key — the
 * fence walks hold every highlighted token they walked — passes its own weight
 * and re-`set`s the entry whenever that cost grows.
 *
 * Bounding by weight — not by an entry count — keeps a transcript of a few huge
 * messages from pinning as much memory as a transcript of thousands of tiny
 * ones.
 */
export class CharacterBoundedCache<T> {
  private readonly entries = new Map<string, { value: T; weight: number }>();
  private readonly maxWeight: number;
  private totalWeight = 0;

  constructor(maxWeight: number) {
    this.maxWeight = maxWeight;
  }

  /** Entries currently held. */
  get size(): number {
    return this.entries.size;
  }

  /** Sum of the weights of the entries currently held. */
  get weight(): number {
    return this.totalWeight;
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    // Refresh recency: a Map iterates in insertion order, so re-inserting the
    // entry moves it to the most-recent end.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, weight: number = key.length): void {
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      this.entries.delete(key);
      this.totalWeight -= existing.weight;
    }
    this.entries.set(key, { value, weight });
    this.totalWeight += weight;
    this.evict();
  }

  /** Drop one entry, for a caller that knows the value is no longer needed. */
  delete(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return;
    }
    this.entries.delete(key);
    this.totalWeight -= entry.weight;
  }

  clear(): void {
    this.entries.clear();
    this.totalWeight = 0;
  }

  private evict(): void {
    // Keep the newest entry even when it alone outweighs the budget. The key is
    // the whole cached value, so at 10x the audit's 256 KB message the key alone
    // exceeds the budget; evicting it the instant it was inserted made every
    // `set` a no-op, so a remount re-lexed and re-rendered the value the cache
    // exists to keep. The newest entry is the one the current mount is working
    // on, so dropping older entries first still bounds the cache to one
    // oversized value plus whatever fits beside it.
    while (this.totalWeight > this.maxWeight && this.entries.size > 1) {
      const oldest = this.entries.keys().next();
      if (oldest.done) {
        return;
      }
      const entry = this.entries.get(oldest.value);
      this.entries.delete(oldest.value);
      this.totalWeight -= entry?.weight ?? 0;
    }
  }
}
