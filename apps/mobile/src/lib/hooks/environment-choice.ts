import { useSyncExternalStore } from 'react';
import { z } from 'zod';

import { createSecureStorePreference } from '@/lib/hooks/secure-store-preference';
import { LAST_CLOUD_ENVIRONMENT_KEY } from '@/lib/storage-keys';

/**
 * The last environment chosen for one repository in one scope. The web keeps
 * the same map in localStorage, so switching back to a repository restores the
 * environment picked for it instead of asking again.
 */
type StoredEnvironmentChoice = Record<string, string>;

const rawStoredEnvironmentChoiceSchema = z.record(z.string(), z.unknown());
const storedEnvironmentIdSchema = z.string();

function parseStoredEnvironmentChoice(raw: string | null): StoredEnvironmentChoice {
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
  store.set({ ...store.getRequested(), [key]: environmentId });
}

export function usePersistedEnvironmentChoice() {
  const stored = useSyncExternalStore(store.subscribe, store.get);
  return { stored, saveEnvironmentChoice };
}
