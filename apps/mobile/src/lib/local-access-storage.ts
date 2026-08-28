import * as SecureStore from 'expo-secure-store';
import { z } from 'zod';

import { chainSave } from '@/lib/hooks/save-chain';
import { encodeStorageKey } from '@/lib/storage-keys';

const recordSchema = z.strictObject({ version: z.literal(1), enabled: z.boolean() });

export type LocalAccessReadResult =
  | Readonly<{ status: 'present'; enabled: boolean }>
  | Readonly<{ status: 'absent' | 'malformed' | 'failed' }>;
export type LocalAccessWriteResult = 'committed' | 'failed' | 'stale';
export type LocalAccessStorage = {
  read: (userId: string) => Promise<LocalAccessReadResult>;
  write: (
    userId: string,
    enabled: boolean,
    isCurrent: () => boolean
  ) => Promise<LocalAccessWriteResult>;
};
type SecurityStore = Pick<typeof SecureStore, 'getItemAsync' | 'setItemAsync'>;

// Unlike account metadata, these keys survive logout. Credentials keep their existing keys/options.
export function localAccessStorageKey(userId: string): string {
  return encodeStorageKey('local-access-v1-', userId);
}

function parseRecord(bytes: string): LocalAccessReadResult {
  try {
    const parsed = recordSchema.safeParse(JSON.parse(bytes));
    return parsed.success
      ? { status: 'present', enabled: parsed.data.enabled }
      : { status: 'malformed' };
  } catch {
    return { status: 'malformed' };
  }
}

export function createLocalAccessStorage(store: SecurityStore = SecureStore): LocalAccessStorage {
  const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
  return {
    read: async userId => {
      const key = localAccessStorageKey(userId);
      // Re-entry must wait for any already-started write for this account, not read its old bytes.
      const result = await chainSave<LocalAccessReadResult>(key, async () => {
        try {
          const bytes = await store.getItemAsync(key, options);
          return bytes === null ? { status: 'absent' } : parseRecord(bytes);
        } catch {
          return { status: 'failed' };
        }
      });
      return result;
    },
    write: async (userId, enabled, isCurrent) => {
      const key = localAccessStorageKey(userId);
      const result = await chainSave<LocalAccessWriteResult>(key, async () => {
        if (!isCurrent()) {
          return 'stale';
        }
        try {
          await store.setItemAsync(key, JSON.stringify({ version: 1, enabled }), options);
          // A native write already in progress can commit to its original account. Never publish
          // that completion as the current attempt's setting after its owner or generation changes.
          return isCurrent() ? 'committed' : 'stale';
        } catch {
          return isCurrent() ? 'failed' : 'stale';
        }
      });
      return result;
    },
  };
}
