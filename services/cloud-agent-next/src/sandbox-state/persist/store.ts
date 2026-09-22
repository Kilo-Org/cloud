/**
 * Canonical writer. The canonical type is the stored shape: `storeAllocation`
 * writes under the canonical key and `storeSession` wraps the aggregate in the
 * `{v: 2}` envelope through the pure `encodeSessionEnvelope` owned by the byte
 * boundary (`access.ts`) and re-exported here.
 */
import type { AllocationRecord } from '../model/allocation.js';
import type { SessionAggregate } from '../model/session.js';
import { encodeSessionEnvelope, eraseAllocationRecord, writeSessionValue } from './access.js';

export { encodeSessionEnvelope };

/** Canonical allocation key; the current raw allocation key is owned by access.ts. */
export const ALLOCATION_KEY = 'sandbox_allocation_state';

export type CanonicalStorage = {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
};

/** Storage that can delete keys; Durable Object storage exposes `delete(keys)`. */
export type ErasableStorage = CanonicalStorage & {
  delete(keys: readonly string[]): Promise<number | void>;
};

export async function storeAllocation(
  storage: CanonicalStorage,
  record: AllocationRecord
): Promise<void> {
  await storage.put(ALLOCATION_KEY, record);
}

export async function storeSession(
  storage: CanonicalStorage,
  aggregate: SessionAggregate
): Promise<void> {
  await writeSessionValue(storage, encodeSessionEnvelope(aggregate));
}

/**
 * Erase the allocation aggregate. `SandboxControl.eraseRecord` owns allocation
 * storage only; deleting both the canonical and the raw allocation key blocks
 * legacy fallback, so a later load is an explicit first boot rather than a
 * resurrection. The session aggregate is untouched.
 */
export async function eraseAllocation(storage: ErasableStorage): Promise<void> {
  await eraseAllocationRecord(storage, [ALLOCATION_KEY]);
}
