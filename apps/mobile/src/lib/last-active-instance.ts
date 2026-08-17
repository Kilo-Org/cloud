import * as SecureStore from 'expo-secure-store';

import { deleteAccountMetadata, setAccountMetadata } from '@/lib/auth/account-metadata-write';
import { LAST_ACTIVE_INSTANCE_KEY } from '@/lib/storage-keys';

let cached: string | null = null;

export async function loadLastActiveInstance(): Promise<void> {
  const stored = await SecureStore.getItemAsync(LAST_ACTIVE_INSTANCE_KEY);
  cached ??= stored;
}

export function getLastActiveInstance(): string | null {
  return cached;
}

export async function setLastActiveInstance(sandboxId: string): Promise<void> {
  cached = sandboxId;
  await setAccountMetadata(LAST_ACTIVE_INSTANCE_KEY, sandboxId);
}

export async function clearLastActiveInstance(): Promise<void> {
  cached = null;
  await deleteAccountMetadata(LAST_ACTIVE_INSTANCE_KEY);
}
