import * as Sentry from '@sentry/react-native';
import * as SecureStore from '@/lib/auth/secure-store';
import * as z from 'zod';

// Module-local key: this slice does not own storage-keys.ts, so the key is
// declared here. It is deliberately NOT deleted on sign-out and needs no
// auth-context deletion site — the record self-expires via its TTL.
const PENDING_EXTERNAL_AUTH_KEY = 'pending-external-auth';

type PendingExternalAuth = {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  /** When the server's code expires, in `Date.now()` milliseconds. */
  expiresAt: number;
};

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
    Sentry.captureException(error, {
      tags: { 'error.subsystem': 'auth', 'error.operation': 'write_pending_external_auth' },
    });
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
//
// Total: a rejected read is the same recoverable outcome as an absent record.
// The guarded store reports the failure at warning level with the stable read
// fingerprint before rethrowing, so catching here leaves exactly one event. It
// must not reject — the mount effect `void`s this read, so a rejection would
// surface as an unhandled error instead of the idle screen, and the person
// could still start sign-in again.
export async function readPendingExternalAuth(): Promise<PendingExternalAuthReadResult> {
  let raw: string | null = null;
  try {
    raw = await SecureStore.getItemAsync(PENDING_EXTERNAL_AUTH_KEY);
  } catch {
    return { kind: 'none' };
  }
  if (!raw) {
    return { kind: 'none' };
  }
  const record = parsePendingExternalAuth(raw);
  // The record never outlives the server code it names.
  if (!record || Date.now() >= record.expiresAt) {
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

const pendingExternalAuthSchema = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  verificationUrl: z.string(),
  expiresAt: z.number(),
});

function parsePendingExternalAuth(raw: string): PendingExternalAuth | null {
  try {
    const result = pendingExternalAuthSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
