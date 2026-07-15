import { type LocalRuntimeFence } from './local-runtime-catalog-types';

/**
 * Strongly-typed request ID. The server contract requires a UUID; keeping
 * the brand separate from `string` lets the orchestrator tell at a glance
 * which strings have been minted by this store.
 */
export type RequestIdUuid = string & { readonly __brand: 'LocalSessionRequestId' };

export type LocalSessionRequestIdStore = {
  /**
   * Return the requestId bound to the exact fence, allocating a new one
   * when none is bound. Allocation is invisible to callers — repeated
   * `getOrAcquire` calls for the same fence always return the same ID.
   */
  getOrAcquire: (fence: LocalRuntimeFence) => RequestIdUuid;
  /**
   * Forget the requestId bound to the exact fence, if any. A subsequent
   * `getOrAcquire(fence)` will allocate a new UUID. No-op when the fence
   * has no entry. Other fences are untouched.
   */
  clearByFence: (fence: LocalRuntimeFence) => void;
  /**
   * Drop every cached requestId. Used when the runtime list goes empty or
   * when the user is logged out.
   */
  clearAll: () => void;
  /**
   * Convenience: clear the requestId bound to the exact fence. The
   * orchestrator calls this on a successful create so the next attempt
   * starts a fresh request ID.
   */
  markSuccess: (fence: LocalRuntimeFence) => void;
};

type CreateLocalSessionRequestIdStoreOptions = {
  /**
   * UUID factory. The orchestrator hook always passes
   * `Crypto.randomUUID`; tests inject a deterministic factory to assert
   * allocation behaviour without touching the global `Crypto` object.
   */
  generateUuid: () => RequestIdUuid;
};

function fenceKey(fence: LocalRuntimeFence): string {
  return `${fence.runtimeId}\u0000${fence.connectionId}`;
}

/**
 * Pure, framework-agnostic store for create-mutation request IDs.
 *
 * Lifetime contract (enforced by tests):
 *
 * - The same exact fence (matching both `runtimeId` and `connectionId`)
 *   reuses the same requestId across `getOrAcquire` calls so a retry of
 *   the same user attempt is server-deduplicable.
 * - A fence change — runtimeId change OR connectionId change (i.e. a
 *   reconnect) — drops the old requestId and allocates a new one on the
 *   next `getOrAcquire`. The old ID is never sent to a different runtime.
 * - `markSuccess` / `clearByFence` clear the binding explicitly so a
 *   successful create or a user-driven retry starts a fresh ID without
 *   racing the next `getOrAcquire` call.
 *
 * The store is intentionally tiny and dependency-free; the orchestrator
 * owns one instance and is responsible for lifecycle (clear-on-logout,
 * etc).
 */
export function createLocalSessionRequestIdStore(
  options: CreateLocalSessionRequestIdStoreOptions
): LocalSessionRequestIdStore {
  const entries = new Map<string, RequestIdUuid>();
  const { generateUuid } = options;

  return {
    getOrAcquire(fence) {
      const key = fenceKey(fence);
      const existing = entries.get(key);
      if (existing !== undefined) {
        return existing;
      }
      const minted = generateUuid();
      entries.set(key, minted);
      return minted;
    },
    clearByFence(fence) {
      entries.delete(fenceKey(fence));
    },
    clearAll() {
      entries.clear();
    },
    markSuccess(fence) {
      entries.delete(fenceKey(fence));
    },
  };
}
