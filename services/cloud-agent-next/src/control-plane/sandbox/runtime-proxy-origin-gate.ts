import type { SecretBinding } from '../../auth.js';
import { runtimeProxyOriginProof } from '../../runtime-credential-proxy-origin.js';
import { constantTimeEqual } from './accepted-handles.js';

/**
 * The allocation that started after origin proofs shipped. An allocation that
 * started earlier may run with a network policy that does not add the proof,
 * so it stays exempt until it stops.
 */
export const RUNTIME_PROXY_ORIGIN_ALLOCATION_KEY = 'runtime_proxy_origin_allocation';

type OriginStorage = {
  get(key: string): unknown;
  put(key: string, value: unknown): void;
  delete(key: string): boolean;
};

/** Call atomically with the allocation write, only when its identity changes. */
export function markRuntimeProxyOriginAllocation(
  storage: OriginStorage,
  allocationId: string | null
): void {
  if (allocationId === null) storage.delete(RUNTIME_PROXY_ORIGIN_ALLOCATION_KEY);
  else storage.put(RUNTIME_PROXY_ORIGIN_ALLOCATION_KEY, allocationId);
}

/**
 * Whether a runtime credential proxy request came through this sandbox's
 * egress. Without containment there is no platform egress to add a proof, so
 * nothing is required. Otherwise a missing or wrong proof fails closed.
 */
export async function runtimeProxyOriginAdmitted(input: {
  storage: OriginStorage;
  env: { NEXTAUTH_SECRET?: SecretBinding };
  allocationId: string;
  outboundId: string | null;
  presented: string | undefined;
}): Promise<boolean> {
  if (input.outboundId === null) return true;
  if (input.storage.get(RUNTIME_PROXY_ORIGIN_ALLOCATION_KEY) !== input.allocationId) return true;
  if (typeof input.presented !== 'string' || input.presented.length === 0) return false;
  const expected = await runtimeProxyOriginProof(input.env, input.outboundId);
  return expected !== null && constantTimeEqual(expected, input.presented);
}
