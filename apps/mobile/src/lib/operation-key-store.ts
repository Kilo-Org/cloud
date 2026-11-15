/**
 * Fingerprint -> operation key for intents whose identity must outlive the
 * component that sent them.
 *
 * The ledger's dedupe identity is `(user, domain, operation_key)` and it
 * survives a screen dismissal, so the key that admitted an ambiguous write
 * must survive it too: an intent whose outcome is still unknown keeps its key
 * no matter how many other intents arrive. An entry lives until it is retired
 * by an authoritative outcome (the ledger replayed, or the write was refused)
 * or by the account boundary — never evicted to make room, because dropping an
 * unresolved intent and minting a replacement is exactly the double-execution
 * this store prevents. Admission is bounded instead: once the store holds
 * `RETAINED_OPERATION_KEY_LIMIT` unresolved intents, a new one is refused.
 *
 * Pure and injectable: the owning domain passes its mint, and tests mint their
 * own. No React, no module-level state of its own.
 */

/**
 * How many unresolved intents the store keeps for one domain. Every entry is a
 * write whose outcome is still unknown, so the bound refuses a new intent rather
 * than evicting one: only an authoritative retirement frees a slot. A distinct
 * fingerprint per edited request means a session of repeated retries can grow
 * this map, and this many unresolved writes is far beyond what one interactive
 * session can produce.
 */
export const RETAINED_OPERATION_KEY_LIMIT = 32;

export type RetainedOperationKeys = {
  /**
   * The key for this fingerprint, minted on first use and kept until retired.
   * `null` means the store is full of unresolved intents and refused this new
   * one; minting or reusing a key anyway would lose the write's dedupe identity.
   */
  getKey(fingerprint: string): string | null;
  /**
   * Forgets one intent, so its next `getKey` mints a fresh key. `operationKey`
   * is the key the caller captured: the entry is dropped only while it is still
   * the stored one, so an outcome that arrives from an earlier admission — one
   * the account boundary already replaced — cannot retire the current intent.
   */
  retireKey(fingerprint: string, operationKey: string): void;
  /** Forgets every intent: the account boundary. */
  clear(): void;
};

export function createRetainedOperationKeys(mint: () => string): RetainedOperationKeys {
  const keys = new Map<string, string>();
  return {
    getKey(fingerprint) {
      const held = keys.get(fingerprint);
      if (held !== undefined) {
        return held;
      }
      if (keys.size >= RETAINED_OPERATION_KEY_LIMIT) {
        return null;
      }
      const minted = mint();
      keys.set(fingerprint, minted);
      return minted;
    },
    retireKey(fingerprint, operationKey) {
      if (keys.get(fingerprint) !== operationKey) {
        return;
      }
      keys.delete(fingerprint);
    },
    clear() {
      keys.clear();
    },
  };
}
