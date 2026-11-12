import { enrolledByocVercelOwner } from './byoc/vercel-owner.js';
import {
  fetchByocVercelEnrollment,
  fetchByocVercelEnrollmentForUser,
} from './byoc/vercel-credential-resolver.js';
import { TRPCError } from '@trpc/server';
import {
  CLOUDFLARE_SANDBOX_SMALL_NATIVE_ALLOCATION,
  SELECTABLE_SANDBOX_ALLOCATIONS,
  getSandboxAllocation,
  getSandboxAllocationProvider,
  getSandboxAllocationRequest,
  isSandboxAllocationAvailable,
  type SandboxAllocation,
  type SandboxSelectionCapabilities,
} from '@kilocode/worker-utils/sandbox-allocation';
import { getDefaultSandboxDestination, isOrgInList } from './sandbox-id.js';
import type { Env } from './types.js';

export { isSandboxAllocationAvailable } from '@kilocode/worker-utils/sandbox-allocation';

type SelectionOwner = { userId: string; orgId?: string };

export type SessionRepositoryType = 'github' | 'gitlab' | 'bitbucket' | 'git';

export const RETIRED_SANDBOX_ALLOCATION_MESSAGE =
  'This sandbox allocation has been retired. Choose Cloudflare Containers or Vercel BYOC.';

/**
 * Retired allocations a new session cannot choose. `cloudflare-shared` is gone
 * because every sandbox serves one workspace. `cloudflare-single` is not here:
 * it is the compatibility alias for the native containers default.
 */
export function isRetiredSandboxAllocation(allocation: SandboxAllocation): boolean {
  return allocation === 'cloudflare-shared' || allocation === 'isolated-standard';
}

/**
 * Provider tool capability a session needs from its sandbox image. `review`
 * publishes code-review output (gh/glab/bb and the GitHub review publisher MCP);
 * `remediation` opens security-remediation pull requests (gh/glab/bb). The
 * Vercel snapshot ships none of these binaries, so a Vercel choice is
 * ineligible for either, independent of the repository platform.
 */
export type SandboxAllocationCapability = 'review' | 'remediation';

const VERCEL_NOT_ENROLLED_REASON =
  'Configure Vercel BYOC in Cloud Agent settings to use Vercel compute';
const VERCEL_NOT_READY_REASON = 'Vercel compute setup is not ready';

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

export function sandboxAllocationUnavailableReason(
  env: Env,
  owner: SelectionOwner,
  allocation: SandboxAllocation,
  capability?: SandboxAllocationCapability,
  vercelUnavailableReason?: string
): string | undefined {
  const capabilityReason = sandboxAllocationProviderCapabilityReason(allocation, capability);
  if (capabilityReason) return capabilityReason;
  const provider = getSandboxAllocationProvider(allocation);
  switch (provider) {
    case 'cloudflare':
      return undefined;
    case 'vercel':
      if (enrolledByocVercelOwner(env, owner) === undefined) {
        return VERCEL_NOT_ENROLLED_REASON;
      }
      return vercelUnavailableReason;
    case 'cloudflare-containers':
      return undefined;
    default: {
      const exhaustive: never = provider;
      return `Sandbox allocation provider ${String(exhaustive)} is not supported`;
    }
  }
}

export function getSandboxSelectionCapabilities(
  env: Env,
  owner: SelectionOwner,
  options?: {
    repositoryType?: SessionRepositoryType;
    capability?: SandboxAllocationCapability;
    vercelUnavailableReason?: string;
  }
): SandboxSelectionCapabilities {
  const selectionAllowed =
    isOrgInList(env.SANDBOX_SELECTION_IDS, owner.userId) ||
    isOrgInList(env.SANDBOX_SELECTION_IDS, owner.orgId);
  if (!selectionAllowed && enrolledByocVercelOwner(env, owner) === undefined) {
    // Owners without selection still run somewhere; report where so the UI can
    // show it without offering a choice.
    return {
      enabled: false,
      defaultDestination: getDefaultSandboxDestination(env, owner),
      options: [],
    };
  }

  const capability = options?.capability;
  // Report every selectable allocation with its unavailability reasons so the
  // picker can show disabled entries; a reason-bearing option is unavailable.
  const candidates = SELECTABLE_SANDBOX_ALLOCATIONS.map(allocation => {
    const unavailableReason = sandboxAllocationUnavailableReason(
      env,
      owner,
      allocation,
      capability,
      options?.vercelUnavailableReason
    );
    return {
      allocation: getSandboxAllocationRequest(allocation),
      ...(unavailableReason ? { unavailableReason } : {}),
    };
  });
  return {
    enabled: true,
    defaultDestination: getDefaultSandboxDestination(env, owner),
    options: candidates,
  };
}

export type VercelSelectionReadiness = {
  vercelUnavailableReason?: string;
};

export async function resolveVercelSelectionReadiness(
  env: Env,
  owner: SelectionOwner
): Promise<VercelSelectionReadiness> {
  const byocOwner = enrolledByocVercelOwner(env, owner);
  if (byocOwner === undefined) return {};
  try {
    const enrollment =
      byocOwner.organizationId !== undefined
        ? await fetchByocVercelEnrollment(env, byocOwner.organizationId)
        : await fetchByocVercelEnrollmentForUser(env, byocOwner.userId);
    return enrollment.setupStatus === 'ready'
      ? {}
      : { vercelUnavailableReason: VERCEL_NOT_READY_REASON };
  } catch {
    return { vercelUnavailableReason: VERCEL_NOT_READY_REASON };
  }
}

export function assertSandboxAllocationAvailable(
  env: Env,
  owner: SelectionOwner,
  allocation: SandboxAllocation,
  repositoryType?: SessionRepositoryType,
  capability?: SandboxAllocationCapability
): void {
  // Retired explicit choices are rejected with a specific reason; a saved value
  // is skipped before this check and falls through to the default.
  if (isRetiredSandboxAllocation(allocation)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: RETIRED_SANDBOX_ALLOCATION_MESSAGE });
  }
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
  if (isSandboxAllocationAvailable(capabilities, allocation)) return;
  const effectiveAllocation =
    allocation === 'cloudflare-single' ? CLOUDFLARE_SANDBOX_SMALL_NATIVE_ALLOCATION : allocation;
  const option = capabilities.options.find(
    candidate => getSandboxAllocation(candidate.allocation) === effectiveAllocation
  );
  throw new TRPCError({
    code: 'BAD_REQUEST',
    message:
      option?.unavailableReason ??
      option?.repositoryUnavailableReason ??
      sandboxAllocationUnavailableReason(env, owner, effectiveAllocation, capability) ??
      'Sandbox allocation is unavailable',
  });
}
