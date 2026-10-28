import { z } from 'zod';
import type { ControlPlaneRouteSpec } from '../../shared/control-plane-protocol.js';
import type { SessionCredentialGrant } from '../../sandbox-control/session-credentials.js';

export const RUNTIME_CONTRACT_KEY = 'allocation_runtime_contract';
const contractSchema = z.object({
  allocationId: z.string(),
  mode: z.enum(['pending', 'legacy', 'worktree']),
});
type RuntimeContract = z.infer<typeof contractSchema>['mode'];
type ContractStorage = {
  get(key: string): unknown;
  put(key: string, value: unknown): void;
  delete(key: string): boolean;
};

/** Missing records belong to allocations created before capability negotiation. */
export function readRuntimeContract(
  storage: ContractStorage,
  allocationId: string | null
): RuntimeContract {
  if (allocationId === null) return 'pending';
  const stored = storage.get(RUNTIME_CONTRACT_KEY);
  if (stored === undefined) return 'legacy';
  const contract = contractSchema.parse(stored);
  return contract.allocationId === allocationId ? contract.mode : 'legacy';
}

/** Call atomically with the allocation write, only when its identity changes. */
export function resetRuntimeContract(storage: ContractStorage, allocationId: string | null): void {
  if (allocationId === null) storage.delete(RUNTIME_CONTRACT_KEY);
  else storage.put(RUNTIME_CONTRACT_KEY, { allocationId, mode: 'pending' });
}

/** Pin the first authenticated wrapper's contract for this allocation's lifetime. */
export function acceptRuntimeContract(
  storage: ContractStorage,
  allocationId: string,
  capability: 'worktree' | undefined
): boolean {
  const mode = readRuntimeContract(storage, allocationId);
  if (mode === 'pending') {
    storage.put(RUNTIME_CONTRACT_KEY, { allocationId, mode: capability ?? 'legacy' });
    return true;
  }
  // A reconnect must not switch process keys, HOME or credential ownership.
  return mode === 'legacy' || capability === 'worktree';
}

/** Stored route specs retain the compatibility field until the wire boundary. */
export function runtimeSpecForContract(
  spec: ControlPlaneRouteSpec,
  mode: RuntimeContract
): ControlPlaneRouteSpec {
  if (mode !== 'worktree') return spec;
  const { runtimeIsolation: _runtimeIsolation, ...shared } = spec;
  return shared;
}

/** Existing isolated runtimes may keep different credential classes in one checkout. */
export function canShareLegacyRepositoryCredentials(
  existing: SessionCredentialGrant,
  candidate: SessionCredentialGrant,
  member: { sessionId: string; kiloSessionId: string }
): boolean {
  return (
    existing.scopeId === candidate.scopeId &&
    existing.repository?.type === 'git' &&
    candidate.repository?.type === 'git' &&
    existing.userId === candidate.userId &&
    existing.orgId === candidate.orgId &&
    existing.directory === candidate.directory &&
    existing.provider === candidate.provider &&
    existing.outboundContainerId === candidate.outboundContainerId &&
    existing.containmentEnabled === candidate.containmentEnabled &&
    JSON.stringify(existing.repository) === JSON.stringify(candidate.repository) &&
    JSON.stringify(existing.kilo.targets) === JSON.stringify(candidate.kilo.targets) &&
    !existing.members.some(
      current =>
        current.sessionId === member.sessionId || current.kiloSessionId === member.kiloSessionId
    )
  );
}
