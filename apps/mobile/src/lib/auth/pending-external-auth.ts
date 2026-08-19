import * as Sentry from '@sentry/react-native';
import * as SecureStore from 'expo-secure-store';

// Module-local key: this slice does not own storage-keys.ts, so the key is
// declared here. It is deliberately NOT deleted on sign-out and needs no
// auth-context deletion site — the record self-expires via its TTL.
const PENDING_EXTERNAL_AUTH_KEY = 'pending-external-auth';

type PendingExternalAuth = {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  startedAt: number;
};

// Matches POLL_OVERALL_TIMEOUT_MS so the record never outlives the server code.
export const PENDING_EXTERNAL_AUTH_TTL_MS = 5 * 60 * 1000;

// Serializes every SecureStore write and clear to PENDING_EXTERNAL_AUTH_KEY
// through one FIFO chain so a later clear always lands after an earlier write.
// A failure is reported to Sentry and the chain continues.
let pendingExternalAuthWriteChain: Promise<void> | undefined = undefined;

async function runWriteAfter(
  previous: Promise<void> | undefined,
  write: () => Promise<void>
): Promise<void> {
  if (previous) {
    await previous;
  }
  try {
    await write();
  } catch (error: unknown) {
    Sentry.captureException(error);
  }
}

async function enqueuePendingExternalAuthWrite(write: () => Promise<void>): Promise<void> {
  const previous = pendingExternalAuthWriteChain;
  const next = runWriteAfter(previous, write);
  pendingExternalAuthWriteChain = next;
  await next;
}

export async function writePendingExternalAuth(record: PendingExternalAuth): Promise<void> {
  const serialized = JSON.stringify(record);
  await enqueuePendingExternalAuthWrite(async () => {
    await SecureStore.setItemAsync(PENDING_EXTERNAL_AUTH_KEY, serialized);
  });
}

export type PendingExternalAuthReadResult =
  | { kind: 'none' }
  | { kind: 'stale' }
  | { kind: 'valid'; record: PendingExternalAuth };

// Reads WITHOUT clearing. The caller must clear a `stale` record itself, after
// its own epoch check, so a concurrent `start()` write is never deleted by a
// restore read that observed the older record.
export async function readPendingExternalAuth(): Promise<PendingExternalAuthReadResult> {
  const raw = await SecureStore.getItemAsync(PENDING_EXTERNAL_AUTH_KEY);
  if (!raw) {
    return { kind: 'none' };
  }
  const record = parsePendingExternalAuth(raw);
  if (!record || Date.now() - record.startedAt > PENDING_EXTERNAL_AUTH_TTL_MS) {
    return { kind: 'stale' };
  }
  return { kind: 'valid', record };
}

export async function clearPendingExternalAuth(): Promise<void> {
  await enqueuePendingExternalAuthWrite(async () => {
    await SecureStore.deleteItemAsync(PENDING_EXTERNAL_AUTH_KEY);
  });
}

// Test-only: reset the module-level write chain between cases.
export function _resetPendingExternalAuthForTests(): void {
  pendingExternalAuthWriteChain = undefined;
}

function parsePendingExternalAuth(raw: string): PendingExternalAuth | null {
  try {
    const value = JSON.parse(raw) as Partial<PendingExternalAuth>;
    if (
      typeof value.deviceCode !== 'string' ||
      typeof value.userCode !== 'string' ||
      typeof value.verificationUrl !== 'string' ||
      typeof value.startedAt !== 'number'
    ) {
      return null;
    }
    return value as PendingExternalAuth;
  } catch {
    return null;
  }
}
