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
import { isCloudAgentContainerBillingEnabled } from './container-billing-rollout.js';
import { getDefaultSandboxDestination, isOrgInList } from './sandbox-id.js';
import type { Env } from './types.js';

type SelectionOwner = { userId: string; orgId?: string };

export function getSandboxSelectionCapabilities(
  env: Env,
  owner: SelectionOwner,
  devcontainer = false
): SandboxSelectionCapabilities {
  if (!owner.orgId || !isOrgInList(env.SANDBOX_SELECTION_ORG_IDS, owner.orgId)) {
    return { enabled: false, options: [] };
  }

  const vercelUnavailableReason = !parseVercelSandboxRuntimeConfig(env)
    ? 'Vercel sandboxes are not configured'
    : isCloudAgentContainerBillingEnabled(env, owner)
      ? 'Vercel sandboxes do not support enforced compute billing'
      : undefined;

  return {
    enabled: true,
    defaultDestination: getDefaultSandboxDestination(env, owner, devcontainer),
    options: SELECTABLE_SANDBOX_ALLOCATIONS.map(allocation => {
      const reason =
        getSandboxAllocationProvider(allocation) === 'vercel' ? vercelUnavailableReason : undefined;
      return {
        allocation: getSandboxAllocationRequest(allocation),
        available: reason === undefined,
        ...(reason ? { reason } : {}),
      };
    }),
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
        option => getKiloSandboxAllocation(option.allocation) === allocation && option.available
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
    const option = capabilities.options.find(
      option => getKiloSandboxAllocation(option.allocation) === allocation
    );
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: option?.reason ?? 'Sandbox allocation is unavailable',
    });
  }
}
