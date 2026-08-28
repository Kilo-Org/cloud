/* eslint-disable max-lines -- one process owner keeps lifecycle, setting publication, and lease fencing atomic */
import { type AppStateStatus } from 'react-native';

import {
  type LocalAccessReadResult,
  type LocalAccessStorage,
  type LocalAccessWriteResult,
} from '@/lib/local-access-storage';
import {
  type LocalAuthenticationFailure,
  type LocalAuthenticationOutcome,
} from '@/lib/local-authentication';

export type LocalAccessScope = Readonly<{ userId: string; organizationId: string | null }>;
export type LocalAccessLease = LocalAccessScope &
  Readonly<{ authEpoch: number; unlockGeneration: number }>;
type Recovery =
  | LocalAuthenticationFailure
  | Readonly<{ status: 'retryable'; reason: 'read_failed' | 'write_failed' | 'invalid_clock' }>
  | Readonly<{ status: 'repair'; reason: 'malformed' }>;
export type LocalAccessSnapshot = Readonly<{
  userId: string | null;
  authEpoch: number;
  unlockGeneration: number;
  contextReady: boolean;
  foregroundReady: boolean;
  unlocked: boolean;
  preference: LocalAccessReadResult['status'] | 'uninitialized' | 'loading';
  enabled: boolean | null;
  operation: 'idle' | 'authenticating' | 'writing';
  recovery: Recovery | null;
}>;
export type LocalAccessDependencies = {
  storage: LocalAccessStorage;
  authenticate: () => Promise<LocalAuthenticationOutcome>;
  lifecycle: {
    getCurrentState: () => AppStateStatus;
    subscribe: (listener: (state: AppStateStatus) => void) => () => void;
  };
  now?: () => number;
};
export type LocalAccessAction = 'unlock' | 'enable' | 'disable' | 'repair';
export type LocalAccessActionResult =
  | LocalAccessWriteResult
  | LocalAuthenticationFailure
  | 'unlocked'
  | 'pending-foreground'
  | 'busy'
  | 'denied';

let snapshot: LocalAccessSnapshot = Object.freeze({
  userId: null,
  authEpoch: 0,
  unlockGeneration: 0,
  contextReady: false,
  foregroundReady: false,
  unlocked: false,
  preference: 'uninitialized',
  enabled: null,
  operation: 'idle',
  recovery: null,
});
let dependencies: LocalAccessDependencies | null = null;
let ownerGeneration = 0;
let attemptGeneration = 0;
let readGeneration = 0;
let granted = false;
let pendingGrant: number | null = null;
let backgroundAt: number | null = null;
let automaticAllowed = true;
let inFlight: Promise<LocalAccessActionResult> | null = null;
const listeners = new Set<() => void>();
const leaseOwners = new WeakMap<LocalAccessLease, number>();

function publish(patch: Partial<LocalAccessSnapshot>): void {
  const next = { ...snapshot, ...patch };
  snapshot = Object.freeze({
    ...next,
    recovery: next.recovery ? Object.freeze(next.recovery) : null,
    unlocked: Boolean(
      dependencies &&
      next.userId &&
      next.foregroundReady &&
      (next.enabled === false || (next.enabled === true && granted))
    ),
  });
  for (const listener of listeners) {
    listener();
  }
}

export function getLocalAccessSnapshot(): LocalAccessSnapshot {
  return snapshot;
}

export function subscribeLocalAccess(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function resetOwner(userId: string | null, authEpoch: number): void {
  ownerGeneration += 1;
  readGeneration += 1;
  attemptGeneration += 1;
  granted = false;
  pendingGrant = null;
  automaticAllowed = true;
  publish({
    userId,
    authEpoch,
    unlockGeneration: snapshot.unlockGeneration + 1,
    contextReady: false,
    preference: 'uninitialized',
    enabled: null,
    operation: 'idle',
    recovery: null,
  });
}

/** Install exactly one process owner. Cleanup denies admission and fences every pending completion. */
export function initializeLocalAccess(input: LocalAccessDependencies): () => void {
  if (dependencies) {
    throw new Error('Local access is already initialized');
  }
  const installed = { ...input };
  dependencies = installed;
  backgroundAt = null;
  resetOwner(null, snapshot.authEpoch);
  onLifecycle(installed.lifecycle.getCurrentState());
  const unsubscribe = installed.lifecycle.subscribe(state => {
    if (dependencies === installed) {
      onLifecycle(state);
    }
  });
  return () => {
    if (dependencies !== installed) {
      return;
    }
    unsubscribe();
    dependencies = null;
    backgroundAt = null;
    resetOwner(null, snapshot.authEpoch);
    publish({ foregroundReady: false });
  };
}

export async function reloadLocalAccessPreference(): Promise<void> {
  const installed = dependencies;
  const userId = snapshot.userId;
  if (!installed || !userId) {
    return;
  }
  const owner = ownerGeneration;
  readGeneration += 1;
  const read = readGeneration;
  attemptGeneration += 1;
  granted = false;
  pendingGrant = null;
  automaticAllowed = true;
  publish({
    preference: 'loading',
    enabled: null,
    recovery: null,
    unlockGeneration: snapshot.unlockGeneration + 1,
  });
  let result: LocalAccessReadResult = { status: 'failed' };
  try {
    result = await installed.storage.read(userId);
  } catch {
    // Keep the failed-read result; rejection is not evidence of absence or malformed bytes.
  }
  if (owner !== ownerGeneration || read !== readGeneration || dependencies !== installed) {
    return;
  }
  const enabled = result.status === 'present' ? result.enabled : null;
  const recovery: Recovery | null =
    result.status === 'failed' ? { status: 'retryable', reason: 'read_failed' } : null;
  publish({
    preference: result.status,
    enabled: result.status === 'absent' ? false : enabled,
    recovery: result.status === 'malformed' ? { status: 'repair', reason: 'malformed' } : recovery,
  });
  if (snapshot.enabled) {
    void requestLocalAccess('unlock', true);
  }
}

/** The auth provider supplies its runtime epoch only after it validates the durable user identity. */
export async function setLocalAccessOwner(userId: string | null, authEpoch: number): Promise<void> {
  if (!dependencies || (snapshot.userId === userId && snapshot.authEpoch === authEpoch)) {
    return;
  }
  resetOwner(userId, authEpoch);
  if (userId) {
    await reloadLocalAccessPreference();
  }
}

export function setLocalAccessContextReady(ready: boolean): void {
  publish({ contextReady: Boolean(dependencies && snapshot.userId && ready) });
}

/** Revoke a grant, not the durable preference. Cancellation still requires explicit Retry. */
export function lockLocalAccess(): void {
  const hadGrant = granted || pendingGrant !== null;
  automaticAllowed ||= hadGrant;
  granted = false;
  pendingGrant = null;
  attemptGeneration += 1;
  publish({
    unlockGeneration: snapshot.unlockGeneration + 1,
    recovery: hadGrant ? null : snapshot.recovery,
  });
}

function onLifecycle(state: AppStateStatus): void {
  if (state === 'background' && backgroundAt === null) {
    backgroundAt = (dependencies?.now ?? Date.now)();
  }
  if (state === 'active' && backgroundAt !== null) {
    const elapsed = (dependencies?.now ?? Date.now)() - backgroundAt;
    backgroundAt = null;
    const invalid = !Number.isFinite(elapsed) || elapsed < 0;
    // Repair and enable attempts need expiry fencing before the enabled preference publishes.
    if ((snapshot.enabled || snapshot.operation !== 'idle') && (invalid || elapsed >= 300_000)) {
      lockLocalAccess();
      if (invalid) {
        publish({ recovery: { status: 'retryable', reason: 'invalid_clock' } });
      }
    }
  }
  // Evaluate expiry before any foreground publication. A prompt can finish while iOS is inactive.
  if (state === 'active' && pendingGrant === attemptGeneration) {
    granted = true;
    pendingGrant = null;
  }
  publish({ foregroundReady: state === 'active' });
  if (snapshot.foregroundReady && snapshot.enabled && !snapshot.unlocked) {
    void requestLocalAccess('unlock', true);
  }
}

function acceptAuthentication(
  patch?: Pick<LocalAccessSnapshot, 'preference' | 'enabled'>
): 'unlocked' | 'pending-foreground' {
  if (snapshot.foregroundReady) {
    granted = true;
  } else {
    pendingGrant = attemptGeneration;
  }
  // Publish the committed setting and its grant together. A subscriber can replace the account.
  publish({ ...patch, recovery: null });
  return snapshot.foregroundReady ? 'unlocked' : 'pending-foreground';
}

/** Automatic calls coalesce. Cancellation never schedules another prompt; Retry uses automatic=false. */
export async function requestLocalAccess(
  action: LocalAccessAction = 'unlock',
  automatic = false
): Promise<LocalAccessActionResult> {
  if (inFlight) {
    if (action !== 'unlock') {
      return 'busy';
    }
    const result = await inFlight;
    return result;
  }
  const installed = dependencies;
  const userId = snapshot.userId;
  const settingAllowed =
    action === 'repair' ? snapshot.preference === 'malformed' : snapshot.enabled !== null;
  const allowed = action === 'unlock' ? snapshot.enabled === true : settingAllowed;
  if (
    !installed ||
    !userId ||
    !snapshot.foregroundReady ||
    !allowed ||
    (automatic && !automaticAllowed)
  ) {
    return 'denied';
  }
  automaticAllowed = false;
  const owner = ownerGeneration;
  attemptGeneration += 1;
  const attempt = attemptGeneration;
  const isCurrent = () =>
    dependencies === installed && owner === ownerGeneration && attempt === attemptGeneration;
  const run = async (): Promise<LocalAccessActionResult> => {
    let writing = false;
    try {
      // Reserve the single flight before subscribers or the native adapter can re-enter the owner.
      await Promise.resolve();
      if (!isCurrent() || !snapshot.foregroundReady) {
        return 'stale';
      }
      const outcome = await installed.authenticate();
      if (!isCurrent()) {
        return 'stale';
      }
      if (outcome.status !== 'authenticated') {
        publish({ recovery: outcome });
        return outcome;
      }
      if (action === 'unlock') {
        const result = acceptAuthentication();
        return isCurrent() ? result : 'stale';
      }
      writing = true;
      publish({ operation: 'writing' });
      const enabled = action !== 'disable';
      const result = await installed.storage.write(userId, enabled, isCurrent);
      if (!isCurrent()) {
        return 'stale';
      }
      if (result !== 'committed') {
        publish({ recovery: { status: 'retryable', reason: 'write_failed' } });
        return result;
      }
      acceptAuthentication({ preference: 'present', enabled });
      return isCurrent() ? 'committed' : 'stale';
    } catch {
      if (!isCurrent()) {
        return 'stale';
      }
      const recovery: Recovery = {
        status: 'retryable',
        reason: writing ? 'write_failed' : 'rejected',
      };
      publish({ recovery });
      return writing ? 'failed' : { status: 'retryable', reason: 'rejected' };
    } finally {
      inFlight = null;
      if (owner === ownerGeneration && dependencies === installed) {
        publish({ operation: 'idle' });
      }
    }
  };
  inFlight = run();
  publish({ operation: 'authenticating', recovery: null });
  const result = await inFlight;
  return result;
}

export class LocalAccessDeniedError extends Error {
  readonly code = 'LOCAL_ACCESS_DENIED';
  readonly reason: 'owner' | 'stale' | 'inactive' | 'context' | 'locked';
  constructor(reason: LocalAccessDeniedError['reason']) {
    super(`Local access denied: ${reason}`);
    this.name = 'LocalAccessDeniedError';
    this.reason = reason;
  }
}

/** Only passive completion of already accepted work uses this check; it cannot admit new effects. */
export function assertLocalAccessOwner(lease: LocalAccessLease): void {
  if (
    !dependencies ||
    leaseOwners.get(lease) !== ownerGeneration ||
    lease.userId !== snapshot.userId ||
    lease.authEpoch !== snapshot.authEpoch
  ) {
    throw new LocalAccessDeniedError('owner');
  }
}

/** Native effects also need a native foreground assertion; JavaScript readiness is not native proof. */
export function assertLocalAccessLease(lease: LocalAccessLease): void {
  assertLocalAccessOwner(lease);
  if (lease.unlockGeneration !== snapshot.unlockGeneration) {
    throw new LocalAccessDeniedError('stale');
  }
  if (!snapshot.foregroundReady) {
    throw new LocalAccessDeniedError('inactive');
  }
  if (!snapshot.contextReady) {
    throw new LocalAccessDeniedError('context');
  }
  if (!snapshot.unlocked) {
    throw new LocalAccessDeniedError('locked');
  }
}

export function captureLocalAccessLease(scope: LocalAccessScope): LocalAccessLease {
  const lease = Object.freeze({
    userId: scope.userId,
    organizationId: scope.organizationId,
    authEpoch: snapshot.authEpoch,
    unlockGeneration: snapshot.unlockGeneration,
  });
  leaseOwners.set(lease, ownerGeneration);
  assertLocalAccessLease(lease);
  return lease;
}
