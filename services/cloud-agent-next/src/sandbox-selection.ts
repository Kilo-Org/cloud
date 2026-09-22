import { enrolledByocVercelOwner } from './byoc/vercel-owner.js';
import { TRPCError } from '@trpc/server';
import {
  CLOUDFLARE_SANDBOX_SMALL_NATIVE_ALLOCATION,
  SELECTABLE_SANDBOX_ALLOCATIONS,
  getSandboxAllocation,
  getSandboxAllocationProvider,
  getSandboxAllocationRequest,
  type SandboxAllocation,
  type SandboxSelectionCapabilities,
} from '@kilocode/worker-utils/sandbox-allocation';
import { isCloudflareContainersEnrolled } from './agent-sandbox/cloudflare-containers/cloudflare-containers-runtime-config.js';
import {
  credentialContainmentEnabled,
  getDefaultSandboxDestination,
  isOrgInList,
} from './sandbox-id.js';
import type { Env } from './types.js';

type SelectionOwner = { userId: string; orgId?: string };

export type SessionRepositoryType = 'github' | 'gitlab' | 'bitbucket' | 'git';

/**
 * Provider tool capability a session needs from its sandbox image. `review`
 * publishes code-review output (gh/glab/bb and the GitHub review publisher MCP);
 * `remediation` opens security-remediation pull requests (gh/glab/bb). The
 * Vercel snapshot ships none of these binaries, so a Vercel choice is
 * ineligible for either, independent of the repository platform.
 */
export type SandboxAllocationCapability = 'review' | 'remediation';

export function sandboxAllocationProviderCapabilityReason(
  allocation: SandboxAllocation,
  capability: SandboxAllocationCapability | undefined
): string | undefined {
  if (capability === undefined) return undefined;
  if (getSandboxAllocationProvider(allocation) !== 'vercel') return undefined;
  return capability === 'review'
    ? 'Vercel sandboxes do not include the code-review publishing tools'
    : 'Vercel sandboxes do not include the security-remediation command-line tools';
}

export function isByocIncompatibleAllocation(
  env: Env,
  owner: { userId?: string; orgId?: string },
  allocation: SandboxAllocation
): boolean {
  return (
    enrolledByocVercelOwner(env, owner) !== undefined &&
    getSandboxAllocationProvider(allocation) !== 'vercel'
  );
}

export function sandboxAllocationUnavailableReason(
  env: Env,
  owner: SelectionOwner,
  allocation: SandboxAllocation,
  capability?: SandboxAllocationCapability
): string | undefined {
  const capabilityReason = sandboxAllocationProviderCapabilityReason(allocation, capability);
  if (capabilityReason) return capabilityReason;
  if (isByocIncompatibleAllocation(env, owner, allocation))
    return 'BYOC Vercel accounts cannot select non-Vercel allocations';
  const provider = getSandboxAllocationProvider(allocation);
  switch (provider) {
    case 'cloudflare':
      return undefined;
    case 'vercel':
      if (enrolledByocVercelOwner(env, owner) !== undefined) return undefined;
      return 'Configure Vercel BYOC in Cloud Agent settings to use Vercel compute';
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

/**
 * Repository-compatibility gate for an allocation. Contained Vercel resolves
 * Git credentials only for GitHub, so a saved Vercel choice is ineligible for a
 * GitLab/Bitbucket/Git repository and must fall through to the next candidate.
 */
export function sandboxAllocationRepositoryUnavailableReason(
  allocation: SandboxAllocation,
  repositoryType: SessionRepositoryType
): string | undefined {
  if (getSandboxAllocationProvider(allocation) === 'vercel' && repositoryType !== 'github') {
    return 'Vercel sandboxes support GitHub repositories only';
  }
  return undefined;
}

type SelectionOption = SandboxSelectionCapabilities['options'][number];

/**
 * With credential containment, new sandbox-small sessions run on the native
 * containers size. The picker offers that size in place of the Cloudflare
 * single sandbox, and hides the single sandbox when the native size is already
 * available on its own.
 */
function nativeSmallInPlaceOfSingle(options: SelectionOption[]): SelectionOption[] {
  const isNative = (option: SelectionOption) =>
    getSandboxAllocation(option.allocation) === CLOUDFLARE_SANDBOX_SMALL_NATIVE_ALLOCATION;
  const single = options.find(
    option => getSandboxAllocation(option.allocation) === 'cloudflare-single'
  );
  const nativeAvailable = options.some(
    option => isNative(option) && option.unavailableReason === undefined
  );
  if (!single || nativeAvailable) return options.filter(option => option !== single);
  return options
    .filter(option => !isNative(option))
    .map(option =>
      option === single
        ? {
            ...single,
            allocation: getSandboxAllocationRequest(CLOUDFLARE_SANDBOX_SMALL_NATIVE_ALLOCATION),
          }
        : option
    );
}

export function getSandboxSelectionCapabilities(
  env: Env,
  owner: SelectionOwner,
  options?: {
    repositoryType?: SessionRepositoryType;
    capability?: SandboxAllocationCapability;
  }
): SandboxSelectionCapabilities {
  if (
    !isOrgInList(env.SANDBOX_SELECTION_IDS, owner.userId) &&
    !isOrgInList(env.SANDBOX_SELECTION_IDS, owner.orgId)
  ) {
    // Owners without selection still run somewhere; report where so the UI can
    // show it without offering a choice.
    return {
      enabled: false,
      defaultDestination: getDefaultSandboxDestination(env, owner),
      options: [],
    };
  }

  const repositoryType = options?.repositoryType;
  const capability = options?.capability;
  // Report every selectable allocation with its unavailability reasons so the
  // picker can show disabled entries; a reason-bearing option is unavailable.
  const candidates = SELECTABLE_SANDBOX_ALLOCATIONS.map(allocation => {
    const unavailableReason = sandboxAllocationUnavailableReason(
      env,
      owner,
      allocation,
      capability
    );
    const repositoryUnavailableReason = repositoryType
      ? sandboxAllocationRepositoryUnavailableReason(allocation, repositoryType)
      : undefined;
    return {
      allocation: getSandboxAllocationRequest(allocation),
      ...(unavailableReason ? { unavailableReason } : {}),
      ...(repositoryUnavailableReason ? { repositoryUnavailableReason } : {}),
    };
  });
  return {
    enabled: true,
    defaultDestination: getDefaultSandboxDestination(env, owner),
    options: credentialContainmentEnabled(env)
      ? nativeSmallInPlaceOfSingle(candidates)
      : candidates,
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
        option =>
          getSandboxAllocation(option.allocation) === allocation &&
          option.unavailableReason === undefined &&
          option.repositoryUnavailableReason === undefined
      ))
  );
}

export function assertSandboxAllocationAvailable(
  env: Env,
  owner: SelectionOwner,
  allocation: SandboxAllocation,
  repositoryType?: SessionRepositoryType,
  capability?: SandboxAllocationCapability
): void {
  const capabilities = getSandboxSelectionCapabilities(env, owner, {
    ...(repositoryType ? { repositoryType } : {}),
    ...(capability ? { capability } : {}),
  });
  if (!capabilities.enabled) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Sandbox selection is not enabled for this owner',
    });
  }
  const unavailableReason = isByocIncompatibleAllocation(env, owner, allocation)
    ? sandboxAllocationUnavailableReason(env, owner, allocation, capability)
    : undefined;
  if (unavailableReason !== undefined || !isSandboxAllocationAvailable(capabilities, allocation)) {
    const option = capabilities.options.find(
      candidate => getSandboxAllocation(candidate.allocation) === allocation
    );
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        option?.unavailableReason ??
        option?.repositoryUnavailableReason ??
        unavailableReason ??
        sandboxAllocationUnavailableReason(env, owner, allocation, capability) ??
        'Sandbox allocation is unavailable',
    });
  }
}
