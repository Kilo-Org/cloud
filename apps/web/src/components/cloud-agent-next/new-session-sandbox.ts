import {
  getSandboxAllocationRequest,
  isSandboxAllocationAvailable,
  isSelectableSandboxAllocation,
  sandboxAllocationSchema,
  type SandboxDestination,
  type SandboxSelectionCapabilities,
} from '@kilocode/worker-utils/sandbox-allocation';

/**
 * The sandbox a new session starts in: the environment's own allocation when the server
 * would accept it, else the saved repository or account default. This mirrors
 * `resolveSavedSandboxAllocation`; the server makes the final choice when the session starts.
 */
export function newSessionSandboxDestination(
  environmentAllocation: string | null | undefined,
  capabilities: SandboxSelectionCapabilities | undefined
): SandboxDestination | undefined {
  if (!capabilities) return undefined;
  const allocation = sandboxAllocationSchema.safeParse(environmentAllocation);
  if (
    allocation.success &&
    isSelectableSandboxAllocation(allocation.data) &&
    isSandboxAllocationAvailable(capabilities, allocation.data)
  ) {
    return getSandboxAllocationRequest(allocation.data);
  }
  return capabilities.effectiveDestination ?? capabilities.defaultDestination;
}
