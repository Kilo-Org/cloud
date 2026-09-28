import { deleteAccountMetadata, setAccountMetadata } from '@/lib/auth/account-metadata-write';
import { readStoredValueSafe } from '@/lib/auth/secure-store-value';
import { LAST_ACTIVE_INSTANCE_KEY } from '@/lib/storage-keys';

let cached: string | null = null;

export async function loadLastActiveInstance(): Promise<void> {
  // A failed read is reported and reads as "none remembered": the hint is a
  // convenience, so an unreadable value must not reject into the caller.
  const stored = await readStoredValueSafe(LAST_ACTIVE_INSTANCE_KEY);
  cached ??= stored;
}

export function getLastActiveInstance(): string | null {
  return cached;
}

export async function setLastActiveInstance(sandboxId: string): Promise<void> {
  cached = sandboxId;
  try {
    await setAccountMetadata(LAST_ACTIVE_INSTANCE_KEY, sandboxId);
  } catch {
    // Reported at warning level by the account-metadata write. The in-memory
    // hint is authoritative and the one caller fires this without awaiting
    // (the chat sandbox route mount), so a failed mirror must not surface as
    // an unhandled rejection.
  }
}

export async function clearLastActiveInstance(): Promise<void> {
  cached = null;
  await deleteAccountMetadata(LAST_ACTIVE_INSTANCE_KEY);
}
