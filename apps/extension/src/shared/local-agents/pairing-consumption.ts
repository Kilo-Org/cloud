/* eslint-disable typescript-eslint/consistent-type-definitions -- AGENTS.md prefers type over interface */
/*
 * Remembers pairing fragments that already completed a handshake, so a replay
 * of the same URL does not re-dial. Bounded on purpose: a long-lived service
 * worker must not grow this set for every pairing it ever sees.
 */
const DEFAULT_MAX_ENTRIES = 32;
const DEFAULT_TTL_MS = 10 * 60_000;

export type LocalAgentPairingConsumption = {
  add(key: string): void;
  has(key: string): boolean;
};

export const createPairingConsumption = ({
  maxEntries = DEFAULT_MAX_ENTRIES,
  now,
  ttlMs = DEFAULT_TTL_MS,
}: {
  maxEntries?: number;
  now: () => number;
  ttlMs?: number;
}): LocalAgentPairingConsumption => {
  /* Insertion order is recency order: a re-add moves the key to the end. */
  const entries = new Map<string, number>();

  const prune = (): void => {
    const current = now();

    for (const [key, expiresAt] of entries) {
      if (expiresAt <= current) {
        entries.delete(key);
      }
    }
  };

  return {
    add: (key: string) => {
      prune();
      entries.delete(key);
      entries.set(key, now() + ttlMs);

      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();

        if (oldest.done === true) {
          break;
        }

        entries.delete(oldest.value);
      }
    },
    has: (key: string) => {
      prune();

      return entries.has(key);
    },
  };
};
