import * as SecureStore from 'expo-secure-store';

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
  await SecureStore.setItemAsync(LAST_ACTIVE_INSTANCE_KEY, sandboxId);
}
