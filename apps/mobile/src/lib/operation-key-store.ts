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
 * this store prevents.
 *
 * Pure and injectable: the owning domain passes its mint, and tests mint their
 * own. No React, no module-level state of its own.
 */

export type RetainedOperationKeys = {
  /** The key for this fingerprint, minted on first use and kept until retired. */
  getKey(fingerprint: string): string;
  /** Forgets one intent, so its next `getKey` mints a fresh key. */
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
