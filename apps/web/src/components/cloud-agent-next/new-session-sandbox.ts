import {
  CLOUDFLARE_CONTAINERS_INSTANCES,
  getSandboxAllocationRequest,
  normalizeSandboxAllocation,
  sandboxAllocationSchema,
  type CloudflareContainersInstance,
  type SandboxDestination,
  type SandboxSelectionCapabilities,
} from '@kilocode/worker-utils/sandbox-allocation';

/**
 * The sandbox a new session starts in: the environment's own allocation, else the saved
 * repository or account default. The server makes the final choice when the session starts.
 */
export function newSessionSandboxDestination(
  environmentAllocation: string | null | undefined,
  capabilities: SandboxSelectionCapabilities | undefined
): SandboxDestination | undefined {
  const allocation = sandboxAllocationSchema.safeParse(environmentAllocation);
  if (allocation.success) {
    return getSandboxAllocationRequest(normalizeSandboxAllocation(allocation.data));
  }
  return capabilities?.effectiveDestination ?? capabilities?.defaultDestination;
}

/** The instance of a Kilo-hosted container. Other providers bill compute themselves. */
export function kiloContainersInstance(
  destination: SandboxDestination | undefined
): CloudflareContainersInstance | null {
  if (
    destination?.provider.id !== 'cloudflare-containers' ||
    destination.provider.account !== 'kilo'
  )
    return null;
  return (
    CLOUDFLARE_CONTAINERS_INSTANCES.find(instance => instance === destination.instanceType) ?? null
  );
}
