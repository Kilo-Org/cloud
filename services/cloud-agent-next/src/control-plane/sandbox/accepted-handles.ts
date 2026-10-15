import { z } from 'zod';
import { sameRuntimeProxyControlBinding } from '../../runtime-credential-proxy.js';
import type { ScopeGrantView } from './scope-view.js';

/**
 * The Sandbox-DO-owned set of accepted runtime-credential-proxy handles for a
 * scope. It lives in one DO KV key (not a SQLite table and not a field on the
 * strict credential grant): the set is small, non-relational, and only ever
 * read or written through these helpers, so a JSON key avoids a DO schema
 * migration. Lookups compare SHA-256 digests in constant time; the raw handle is
 * additionally retained (never logged) so the provider credential policy can
 * keep the injection rules of a previously accepted handle until its `exp`,
 * while wrappers that have not yet applied a rotation still hold it.
 *
 * Retirement is synchronous (`retireAcceptedHandlesSync`) so it can share one
 * `transactionSync` with the scope-grant SQL deletes.
 */
export const ACCEPTED_HANDLES_MAX = 4;
const ACCEPTED_HANDLES_KEY = 'runtime_proxy_accepted_handles';

/** The physical control binding a handle was accepted under. */
export type AcceptedHandleFence = {
  plane: 'control';
  allocationId: string;
  providerInstanceId: string;
  connectionId: string;
  wrapperInstanceId: string;
};

export type AcceptedRuntimeProxyHandle = {
  /** SHA-256 hex of the handle string; the constant-time lookup key. */
  handleDigest: string;
  /**
   * The raw handle, retained (never logged) only to project its provider
   * injection rules until `exp`. Optional so a set written before this field
   * existed still loads; its rules are then dropped rather than failing.
   */
  handle?: string;
  /** The Session DO that minted and bound the handle. */
  issuerSessionId: string;
  /** The worktree scope the canonical grant belongs to. */
  scopeId: string;
  /** Handle JWT `exp` in milliseconds. */
  exp: number;
  /** The allocation/wrapper fence the handle was accepted under. */
  fence: AcceptedHandleFence;
};

export type AcceptedHandleStorage = {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
};

/** The synchronous view of DO storage used inside a `transactionSync`. */
export type SyncAcceptedHandleStorage = {
  get<T = unknown>(key: string): T | undefined;
  put(key: string, value: unknown): void;
  delete(key: string): boolean;
  list(): Iterable<[string, unknown]>;
};

export type AcceptedHandleMatch = {
  scopeGrantId: string;
  entry: AcceptedRuntimeProxyHandle;
};

/** Backing-credential identity the Sandbox DO forwards for attestation. */
export type ScopeBackingToken = {
  token: string;
  organizationId?: string;
  runtimeAuthorization: { userId: string; authorizationId: string; resourceId: string };
};

/**
 * The Sandbox DO's scope-handle resolution outcome. `denied` is a known denial
 * on every candidate; `unavailable` means at least one candidate failed on
 * transport and none served, so the facade returns a retryable 503.
 */
export type ScopeHandleResolution =
  | ({ type: 'served'; scopeView: ScopeGrantView } & ScopeBackingToken)
  | { type: 'denied' }
  | { type: 'unavailable' };

export type AcceptedHandleIssuerLocator = {
  scopeId: string;
  allocationId: string;
  wrapperInstanceId: string;
  expiresAt: number;
};

const fenceSchema = z
  .object({
    plane: z.literal('control'),
    allocationId: z.string().min(1),
    providerInstanceId: z.string().min(1),
    connectionId: z.string().min(1),
    wrapperInstanceId: z.string().min(1),
  })
  .strict();

const entrySchema = z
  .object({
    handleDigest: z.string().regex(/^[0-9a-f]{64}$/),
    handle: z.string().min(1).max(4096).optional(),
    issuerSessionId: z.string().min(1),
    scopeId: z.string().min(1),
    exp: z.number().int().positive(),
    fence: fenceSchema,
  })
  .strict();

const storeSchema = z.record(z.string().min(1), z.array(entrySchema));

export async function digestRuntimeProxyHandle(handle: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(handle));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string equality over equal-length digests. */
export function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function readStore(
  storage: AcceptedHandleStorage
): Promise<Record<string, AcceptedRuntimeProxyHandle[]>> {
  const raw = await storage.get<unknown>(ACCEPTED_HANDLES_KEY);
  if (raw === undefined) return {};
  const parsed = storeSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

/**
 * Entries to keep when making room for a new one. Expired entries are pruned,
 * except that pruning never empties a scope's list: when every entry is expired,
 * the most recent one is kept as the adoption marker. A scope therefore stays
 * visibly "adopted" while it recovers from an ended canonical, instead of being
 * mistaken for a pre-deploy per-session scope. A live entry supersedes an
 * expired marker, so the marker is dropped on the next add once one exists.
 */
function pruneForAdd(
  entries: readonly AcceptedRuntimeProxyHandle[],
  now: number
): AcceptedRuntimeProxyHandle[] {
  const live = entries.filter(entry => entry.exp > now);
  if (live.length > 0) return live;
  const [first, ...rest] = entries;
  if (first === undefined) return [];
  return [rest.reduce((best, entry) => (entry.exp > best.exp ? entry : best), first)];
}

/**
 * Whether a scope has adopted a shared canonical handle under `fence`. True when
 * at least one accepted entry is stored for the scope under the fence, INCLUDING
 * an entry whose JWT `exp` has passed: that expired entry is the adoption marker
 * until {@link pruneForAdd} actually removes it, so an adopted scope whose
 * canonical just expired is still recovered rather than treated as per-session.
 */
export async function hasAcceptedScopeHandle(
  storage: AcceptedHandleStorage,
  scopeGrantId: string,
  fence: AcceptedHandleFence
): Promise<boolean> {
  return (
    (await listAcceptedHandlesForScopeIncludingExpired(storage, scopeGrantId, fence)).length > 0
  );
}

/**
 * The unexpired accepted entries for one scope under the current fence. Used by
 * adoption to find the canonical handle a scope is already serving; returns an
 * empty list when the scope has none.
 */
export async function listAcceptedHandlesForScope(
  storage: AcceptedHandleStorage,
  scopeGrantId: string,
  fence: AcceptedHandleFence,
  now = Date.now()
): Promise<AcceptedRuntimeProxyHandle[]> {
  const store = await readStore(storage);
  return (store[scopeGrantId] ?? []).filter(
    entry => entry.exp > now && sameRuntimeProxyControlBinding(entry.fence, fence)
  );
}

/**
 * Every accepted entry for one scope under the current fence, INCLUDING an entry
 * whose JWT `exp` has passed. Membership (digest) checks use this so a scope that
 * adopted a canonical handle is still recognized as adopted while that canonical
 * is expiring or already expired and is being recovered. Serving paths must use
 * {@link lookupAcceptedHandle}, which still rejects an expired handle.
 */
export async function listAcceptedHandlesForScopeIncludingExpired(
  storage: AcceptedHandleStorage,
  scopeGrantId: string,
  fence: AcceptedHandleFence
): Promise<AcceptedRuntimeProxyHandle[]> {
  const store = await readStore(storage);
  return (store[scopeGrantId] ?? []).filter(entry =>
    sameRuntimeProxyControlBinding(entry.fence, fence)
  );
}

/**
 * The raw accepted handle strings per scope id, for the provider credential
 * policy. A previously accepted handle is kept in the policy's injection rules
 * until its `exp`, because a running wrapper that has not yet applied a rotation
 * still sends it. Entries without a retained raw handle are skipped.
 */
export async function listAcceptedHandleStringsByScopeId(
  storage: AcceptedHandleStorage,
  now = Date.now()
): Promise<Map<string, string[]>> {
  const store = await readStore(storage);
  const byScopeId = new Map<string, string[]>();
  for (const entries of Object.values(store)) {
    for (const entry of entries) {
      if (entry.exp <= now || entry.handle === undefined) continue;
      const handles = byScopeId.get(entry.scopeId) ?? [];
      if (!handles.includes(entry.handle)) handles.push(entry.handle);
      byScopeId.set(entry.scopeId, handles);
    }
  }
  return byScopeId;
}

/**
 * Adds one accepted handle inside a `transactionSync`, so an accepted entry
 * commits atomically with the scope grant's member-row write. Expired entries
 * are pruned first, keeping the most recent as the adoption marker when all are
 * expired. The cap includes the canonical entry: once pruning leaves
 * {@link ACCEPTED_HANDLES_MAX} unexpired entries, `add` reports `full` and the
 * caller skips rotation. An unexpired entry is never evicted. A duplicate digest
 * is `present` and refreshes the stored entry in place (its `exp` may have been
 * an expired adoption marker for the same handle). A malformed store is treated
 * as empty and replaced.
 */
export function addAcceptedHandleSync(
  store: SyncAcceptedHandleStorage,
  scopeGrantId: string,
  entry: AcceptedRuntimeProxyHandle,
  now = Date.now()
): 'added' | 'present' | 'full' {
  const raw = store.get<unknown>(ACCEPTED_HANDLES_KEY);
  const parsed = raw === undefined ? undefined : storeSchema.safeParse(raw);
  const data: Record<string, AcceptedRuntimeProxyHandle[]> = parsed?.success ? parsed.data : {};
  const current = pruneForAdd(data[scopeGrantId] ?? [], now);
  const existingIndex = current.findIndex(candidate =>
    constantTimeEqual(candidate.handleDigest, entry.handleDigest)
  );
  if (existingIndex >= 0) {
    // Refresh in place: the matching entry may be an expired adoption marker for
    // the very handle being re-accepted, and a `present` that left its `exp`
    // stale would keep the scope looking adopted with no servable entry.
    current[existingIndex] = entry;
    data[scopeGrantId] = current;
    store.put(ACCEPTED_HANDLES_KEY, data);
    return 'present';
  }
  if (current.length >= ACCEPTED_HANDLES_MAX) {
    data[scopeGrantId] = current;
    store.put(ACCEPTED_HANDLES_KEY, data);
    return 'full';
  }
  current.push(entry);
  data[scopeGrantId] = current;
  store.put(ACCEPTED_HANDLES_KEY, data);
  return 'added';
}

/**
 * Exact-match lookup of a presented handle against the accepted set for the
 * current fence. Scans every scope because the issuer's route may already be
 * gone; the digest and fence are the only keys. Fence equality uses
 * {@link sameRuntimeProxyControlBinding}: a same-wrapper socket reconnect (new
 * connectionId) must not invalidate an otherwise current handle.
 */
export async function lookupAcceptedHandle(
  storage: AcceptedHandleStorage,
  handleString: string,
  fence: AcceptedHandleFence,
  now = Date.now()
): Promise<AcceptedHandleMatch | undefined> {
  const digest = await digestRuntimeProxyHandle(handleString);
  const store = await readStore(storage);
  for (const [scopeGrantId, entries] of Object.entries(store)) {
    for (const entry of entries) {
      if (entry.exp <= now) continue;
      if (!sameRuntimeProxyControlBinding(entry.fence, fence)) continue;
      if (constantTimeEqual(entry.handleDigest, digest)) return { scopeGrantId, entry };
    }
  }
  return undefined;
}

/**
 * The locator a deleted issuer needs to keep resolving through a survivor: the
 * scope, current fence and the latest accepted-lease expiry across the issuer's
 * accepted handles. Null when the issuer has no accepted handle.
 */
export async function acceptedHandleIssuerLocator(
  storage: AcceptedHandleStorage,
  issuerSessionId: string,
  now = Date.now()
): Promise<AcceptedHandleIssuerLocator | null> {
  const store = await readStore(storage);
  let best: AcceptedHandleIssuerLocator | null = null;
  for (const entries of Object.values(store)) {
    for (const entry of entries) {
      if (entry.issuerSessionId !== issuerSessionId || entry.exp <= now) continue;
      if (best !== null && entry.exp <= best.expiresAt) continue;
      best = {
        scopeId: entry.scopeId,
        allocationId: entry.fence.allocationId,
        wrapperInstanceId: entry.fence.wrapperInstanceId,
        expiresAt: entry.exp,
      };
    }
  }
  return best;
}

/**
 * Synchronous retirement for use inside a `transactionSync` shared with the
 * scope-grant SQL deletes in scope-grants.ts. Deletes one scope's accepted set,
 * or the whole side store when no scope is named. Fence retirement removes
 * entries regardless of JWT exp.
 */
export function retireAcceptedHandlesSync(
  store: SyncAcceptedHandleStorage,
  scopeGrantId?: string
): void {
  if (scopeGrantId === undefined) {
    store.delete(ACCEPTED_HANDLES_KEY);
    return;
  }
  const raw = store.get<unknown>(ACCEPTED_HANDLES_KEY);
  if (raw === undefined) return;
  const parsed = storeSchema.safeParse(raw);
  if (!parsed.success) {
    store.delete(ACCEPTED_HANDLES_KEY);
    return;
  }
  const current = parsed.data;
  if (current[scopeGrantId] === undefined) return;
  delete current[scopeGrantId];
  if (Object.keys(current).length === 0) store.delete(ACCEPTED_HANDLES_KEY);
  else store.put(ACCEPTED_HANDLES_KEY, current);
}
