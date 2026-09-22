import { TRPCError } from '@trpc/server';
import {
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
import { getDefaultSandboxDestination, isOrgInList } from './sandbox-id.js';
import type { Env } from './types.js';

type SelectionOwner = { userId: string; orgId?: string };

/**
 * A BYOC-enrolled organization always runs on its own Vercel account, so a
 * non-Vercel allocation would contradict the provider chosen at registration.
 */
export function isByocIncompatibleAllocation(
  env: Env,
  owner: { orgId?: string },
  allocation: SandboxAllocation
): boolean {
  return (
    owner.orgId !== undefined &&
    isOrgInList(env.BYOC_VERCEL_ORG_IDS, owner.orgId) &&
    getSandboxAllocationProvider(allocation) !== 'vercel'
  );
}

function sandboxAllocationUnavailableReason(
  env: Env,
  owner: SelectionOwner,
  allocation: SandboxAllocation
): string | undefined {
  const provider = getSandboxAllocationProvider(allocation);
  if (isByocIncompatibleAllocation(env, owner, allocation)) {
    return 'BYOC Vercel organizations cannot select non-Vercel allocations';
  }
  if (provider === 'cloudflare') return undefined;
  if (provider === 'vercel') {
    if (!parseVercelSandboxRuntimeConfig(env)) return 'Vercel sandboxes are not configured';
    if (isCloudAgentContainerBillingEnabled(env, owner)) {
      return 'Vercel sandboxes do not support enforced compute billing';
    }
    return undefined;
  }
  if (!isCloudflareContainersEnrolled(env, { orgId: owner.orgId })) {
    return 'Cloudflare containers are not enabled for this account';
  }
  return undefined;
}

export function getSandboxSelectionCapabilities(
  env: Env,
  owner: SelectionOwner,
  devcontainer = false
): SandboxSelectionCapabilities {
  if (
    !isOrgInList(env.SANDBOX_SELECTION_IDS, owner.userId) &&
    !isOrgInList(env.SANDBOX_SELECTION_IDS, owner.orgId)
  ) {
    return { enabled: false, options: [] };
  }

  return {
    enabled: true,
    defaultDestination: getDefaultSandboxDestination(env, owner, devcontainer),
    options: SELECTABLE_SANDBOX_ALLOCATIONS.filter(
      allocation => sandboxAllocationUnavailableReason(env, owner, allocation) === undefined
    ).map(allocation => ({ allocation: getSandboxAllocationRequest(allocation) })),
  };
}

export function isSandboxAllocationAvailable(
  capabilities: SandboxSelectionCapabilities,
  allocation: SandboxAllocation
): boolean {
  return (
    capabilities.enabled &&
    (allocation === 'isolated-standard' ||
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
