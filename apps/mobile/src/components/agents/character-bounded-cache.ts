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
 * A caller may also name a `pinned` predicate: an entry whose value matches it
 * is never evicted, because the value is still in use and dropping it would
 * make its next read start over. Pinned entries stay over budget until the
 * caller `set`s them back to a value the predicate rejects, so the budget
 * bounds only what is no longer in use.
 *
 * Bounding by weight — not by an entry count — keeps a transcript of a few huge
 * messages from pinning as much memory as a transcript of thousands of tiny
 * ones.
 */
export class CharacterBoundedCache<T> {
  private readonly entries = new Map<string, { value: T; weight: number; pinned: boolean }>();
  private readonly maxWeight: number;
  private readonly pinned: (value: T) => boolean;
  private totalWeight = 0;
  private pinnedWeight = 0;
  private pinnedEntries = 0;

  constructor(maxWeight: number, pinned: (value: T) => boolean = () => false) {
    this.maxWeight = maxWeight;
    this.pinned = pinned;
  }

  /** Entries currently held. */
  get size(): number {
    return this.entries.size;
  }

  /** Sum of the weights of the entries currently held. */
  get weight(): number {
    return this.totalWeight;
  }

  /** Entries the pinned predicate keeps from being evicted. */
  get pinnedCount(): number {
    return this.pinnedEntries;
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
    this.remove(key);
    const pinned = this.pinned(value);
    this.entries.set(key, { value, weight, pinned });
    this.totalWeight += weight;
    if (pinned) {
      this.pinnedWeight += weight;
      this.pinnedEntries += 1;
    }
    this.evict();
  }

  /** Drop one entry, for a caller that knows the value is no longer needed. */
  delete(key: string): void {
    this.remove(key);
  }

  clear(): void {
    this.entries.clear();
    this.totalWeight = 0;
    this.pinnedWeight = 0;
    this.pinnedEntries = 0;
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return;
    }
    this.entries.delete(key);
    this.totalWeight -= entry.weight;
    if (entry.pinned) {
      this.pinnedWeight -= entry.weight;
      this.pinnedEntries -= 1;
    }
  }

  private newestKey(): string | undefined {
    let last: string | undefined = undefined;
    for (const key of this.entries.keys()) {
      last = key;
    }
    return last;
  }

  private evict(): void {
    // Nothing to drop when the budget holds, or when everything over it is
    // pinned: an entry still in use may not be dropped to make room.
    if (this.totalWeight <= this.maxWeight || this.totalWeight === this.pinnedWeight) {
      return;
    }
    // Keep the newest entry even when it alone outweighs the budget. The key is
    // the whole cached value, so at 10x the audit's 256 KB message the key alone
    // exceeds the budget; evicting it the instant it was inserted made every
    // `set` a no-op, so a remount re-lexed and re-rendered the value the cache
    // exists to keep. The newest entry is the one the current mount is working
    // on, so dropping older entries first still bounds the cache to one
    // oversized value plus whatever fits beside it.
    //
    // Map iteration is the LRU order, so victims are visited oldest-first in
    // this one pass: no key array is built and the weights come from the
    // entries already in hand.
    const newest = this.newestKey();
    for (const key of this.entries.keys()) {
      if (this.totalWeight <= this.maxWeight || key === newest) {
        return;
      }
      const entry = this.entries.get(key);
      if (entry !== undefined && !entry.pinned) {
        this.remove(key);
      }
    }
  }
}
