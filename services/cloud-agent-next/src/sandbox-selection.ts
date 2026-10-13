import { TRPCError } from '@trpc/server';
import {
  CLOUDFLARE_SANDBOX_SMALL_NATIVE_ALLOCATION,
  SELECTABLE_SANDBOX_ALLOCATIONS,
  getKiloSandboxAllocation,
  getSandboxAllocationProvider,
  getSandboxAllocationRequest,
  type SandboxAllocation,
  type SandboxSelectionCapabilities,
} from '@kilocode/worker-utils/sandbox-allocation';
import { parseVercelSandboxRuntimeConfig } from './agent-sandbox/vercel/vercel-runtime-config.js';
import { isCloudflareContainersEnrolled } from './agent-sandbox/cloudflare-containers/cloudflare-containers-runtime-config.js';
import { isCloudAgentContainerBillingEnabled } from './container-billing-rollout.js';
import {
  credentialContainmentEnabled,
  getDefaultSandboxDestination,
  isOrgInList,
} from './sandbox-id.js';
import type { Env } from './types.js';

type SelectionOwner = { userId: string; orgId?: string };

function sandboxAllocationUnavailableReason(
  env: Env,
  owner: SelectionOwner,
  allocation: SandboxAllocation
): string | undefined {
  const provider = getSandboxAllocationProvider(allocation);
  switch (provider) {
    case 'cloudflare':
      return undefined;
    case 'vercel':
      if (!parseVercelSandboxRuntimeConfig(env)) return 'Vercel sandboxes are not configured';
      if (isCloudAgentContainerBillingEnabled(env, owner)) {
        return 'Vercel sandboxes do not support enforced compute billing';
      }
      return undefined;
    case 'cloudflare-containers':
      if (!isCloudflareContainersEnrolled(env, { orgId: owner.orgId })) {
        return 'Cloudflare containers are not enabled for this account';
      }
      return undefined;
    default: {
      const exhaustive: never = provider;
      return `Sandbox allocation provider ${String(exhaustive)} is not supported`;
    }
  }
}

export function getSandboxSelectionCapabilities(
  env: Env,
  owner: SelectionOwner
): SandboxSelectionCapabilities {
  if (
    !isOrgInList(env.SANDBOX_SELECTION_IDS, owner.userId) &&
    !isOrgInList(env.SANDBOX_SELECTION_IDS, owner.orgId)
  ) {
    return { enabled: false, options: [] };
  }

  const available = SELECTABLE_SANDBOX_ALLOCATIONS.filter(
    allocation => sandboxAllocationUnavailableReason(env, owner, allocation) === undefined
  );
  const options = credentialContainmentEnabled(env)
    ? available.flatMap(allocation => {
        if (allocation !== 'cloudflare-single') return [allocation];
        return available.includes(CLOUDFLARE_SANDBOX_SMALL_NATIVE_ALLOCATION)
          ? []
          : [CLOUDFLARE_SANDBOX_SMALL_NATIVE_ALLOCATION];
      })
    : available;

  return {
    enabled: true,
    defaultDestination: getDefaultSandboxDestination(env, owner),
    options: options.map(allocation => ({ allocation: getSandboxAllocationRequest(allocation) })),
  };
}

export function isSandboxAllocationAvailable(
  capabilities: SandboxSelectionCapabilities,
  allocation: SandboxAllocation
): boolean {
  return (
    capabilities.enabled &&
    (allocation === 'isolated-standard' ||
      allocation === 'cloudflare-single' ||
      capabilities.options.some(
        option => getKiloSandboxAllocation(option.allocation) === allocation
      ))
  );
}

export function assertSandboxAllocationAvailable(
  env: Env,
  owner: SelectionOwner,
  allocation: SandboxAllocation
): void {
  const capabilities = getSandboxSelectionCapabilities(env, owner);
  if (!capabilities.enabled) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Sandbox selection is not enabled for this owner',
    });
  }
  if (!isSandboxAllocationAvailable(capabilities, allocation)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        sandboxAllocationUnavailableReason(env, owner, allocation) ??
        'Sandbox allocation is unavailable',
    });
  }
}
