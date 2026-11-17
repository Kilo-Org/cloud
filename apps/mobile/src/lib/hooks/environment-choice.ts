import { useSyncExternalStore } from 'react';
import { z } from 'zod';

import { createSecureStorePreference } from '@/lib/hooks/secure-store-preference';
import { LAST_CLOUD_ENVIRONMENT_KEY } from '@/lib/storage-keys';

/**
 * The last environment chosen for one repository in one scope. The web keeps
 * the same map in localStorage, so switching back to a repository restores the
 * environment picked for it instead of asking again. Entries are ordered by
 * recency: a pick moves its repository to the end of the map, and only the
 * newest {@link MAX_STORED_ENVIRONMENT_CHOICES} repositories are kept.
 */
type StoredEnvironmentChoice = Record<string, string>;

/**
 * One entry per repository a person has picked an environment in. The map is
 * otherwise never pruned by the person, so the oldest picks fall out instead of
 * growing the persisted record for every repository ever opened.
 */
export const MAX_STORED_ENVIRONMENT_CHOICES = 50;

/** The map with `key` holding `environmentId` as its most recent entry. */
export function withEnvironmentChoice(
  stored: StoredEnvironmentChoice,
  key: string,
  environmentId: string
): StoredEnvironmentChoice {
  const entries = Object.entries(stored).filter(([storedKey]) => storedKey !== key);
  entries.push([key, environmentId]);
  return Object.fromEntries(entries.slice(-MAX_STORED_ENVIRONMENT_CHOICES));
}

/** The map without `key`: a choice whose environment is gone leaves nothing behind. */
export function withoutEnvironmentChoice(
  stored: StoredEnvironmentChoice,
  key: string
): StoredEnvironmentChoice {
  return Object.fromEntries(Object.entries(stored).filter(([storedKey]) => storedKey !== key));
}

const rawStoredEnvironmentChoiceSchema = z.record(z.string(), z.unknown());
const storedEnvironmentIdSchema = z.string();

export function parseStoredEnvironmentChoice(raw: string | null): StoredEnvironmentChoice {
  if (!raw) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const shape = rawStoredEnvironmentChoiceSchema.safeParse(parsed);
    if (!shape.success) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(shape.data).flatMap<[string, string]>(([key, value]) => {
        const id = storedEnvironmentIdSchema.safeParse(value);
        return id.success ? [[key, id.data]] : [];
      })
    );
  } catch {
    return {};
  }
}

const store = createSecureStorePreference<StoredEnvironmentChoice>({
  key: LAST_CLOUD_ENVIRONMENT_KEY,
  defaultValue: {},
  parse: parseStoredEnvironmentChoice,
  serialize: value => JSON.stringify(value),
  // A write before the initial disk read settles carries only the key it set;
  // merging the persisted map back in keeps every other repository's choice.
  mergeOnLoad: (disk, pending) => ({ ...disk, ...pending }),
});

// Warm the disk read at module scope: the first render of the new-session form
// must already hold the stored choice, or the picker would reopen on "choose"
// and then replace it a frame later.
store.preload();

export function clearEnvironmentChoices() {
  store.clear();
}

function saveEnvironmentChoice(key: string, environmentId: string) {
  store.set(withEnvironmentChoice(store.getRequested(), key, environmentId));
}

/** Drops one repository's entry, e.g. when its environment is no longer listed. */
export function forgetEnvironmentChoice(key: string) {
  const stored = store.getRequested();
  if (!Object.hasOwn(stored, key)) {
    return;
  }
  store.set(withoutEnvironmentChoice(stored, key));
}

export function usePersistedEnvironmentChoice() {
  const stored = useSyncExternalStore(store.subscribe, store.get);
  return { stored, saveEnvironmentChoice };
}
