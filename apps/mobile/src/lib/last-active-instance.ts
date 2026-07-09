import * as SecureStore from 'expo-secure-store';

import { LAST_ACTIVE_INSTANCE_KEY } from '@/lib/storage-keys';

let cached: string | null = null;

// Persistence writes are serialized so a sign-out clear can never be
// overtaken by an in-flight set, which would leak the previous account's
// sandbox id into the next cold start.
let writeQueue: Promise<void> | null = null;

async function enqueueWrite(op: () => Promise<void>): Promise<void> {
  const previous = writeQueue;
  const next = (async () => {
    if (previous) {
      try {
        await previous;
      } catch {
        // An earlier failed write must not block the queue.
      }
    }
    await op();
  })();
  writeQueue = next;
  await next;
}

export async function loadLastActiveInstance(): Promise<void> {
  const stored = await SecureStore.getItemAsync(LAST_ACTIVE_INSTANCE_KEY);
  cached ??= stored;
}

export function getLastActiveInstance(): string | null {
  return cached;
}

export async function setLastActiveInstance(sandboxId: string): Promise<void> {
  cached = sandboxId;
  await enqueueWrite(async () => {
    await SecureStore.setItemAsync(LAST_ACTIVE_INSTANCE_KEY, sandboxId);
  });
}

export async function clearLastActiveInstance(): Promise<void> {
  cached = null;
  await enqueueWrite(async () => {
    await SecureStore.deleteItemAsync(LAST_ACTIVE_INSTANCE_KEY);
  });
}
