import 'server-only';
import { TRPCError } from '@trpc/server';
import {
  getKiloSandboxAllocation,
  type SandboxSelectionCapabilities,
} from '@kilocode/worker-utils/sandbox-allocation';
import type { User } from '@kilocode/db/schema';
import { createControlTokenForRequest } from '@/lib/auth/resource-delegation';
import {
  createCloudAgentNextClient,
  type GetSandboxSelectionOptionsInput,
} from '@/lib/cloud-agent-next/cloud-agent-client';

/**
 * The one check for whether an owner may save a sandbox allocation. Cloud Agent
 * settings and repository environments both save allocations, so both validate
 * a newly chosen key here against what the Worker offers the owner.
 */

type SandboxRepositoryType = NonNullable<GetSandboxSelectionOptionsInput['repositoryType']>;

export async function loadSandboxCapabilities(
  user: User,
  headersList: Headers | undefined,
  organizationId: string | undefined,
  repositoryType?: SandboxRepositoryType
): Promise<SandboxSelectionCapabilities> {
  const { token } = await createControlTokenForRequest(user, 'cloud-agent-next', {
    headers: headersList,
    ...(organizationId ? { organizationId } : {}),
    tokenSource: 'cloud-agent',
  });
  return createCloudAgentNextClient(token).getSandboxSelectionOptions({
    ...(organizationId ? { kilocodeOrganizationId: organizationId } : {}),
    ...(repositoryType ? { repositoryType } : {}),
  });
}

export function findSandboxOption(
  capabilities: SandboxSelectionCapabilities,
  allocation: string
): SandboxSelectionCapabilities['options'][number] | undefined {
  return capabilities.options.find(
    option => getKiloSandboxAllocation(option.allocation) === allocation
  );
}

export function getSavedAllocationReason(
  capabilities: SandboxSelectionCapabilities,
  allocation: string,
  repositoryType?: SandboxRepositoryType
): string | undefined {
  if (!capabilities.enabled) return 'Sandbox selection is not enabled for this owner';
  const option = findSandboxOption(capabilities, allocation);
  if (!option) return 'This sandbox allocation is no longer offered';
  return repositoryType
    ? (option.repositoryUnavailableReason ?? option.unavailableReason)
    : option.unavailableReason;
}

export function assertAllocationOffered(
  capabilities: SandboxSelectionCapabilities,
  allocation: string,
  repositoryType?: SandboxRepositoryType
): void {
  const reason = getSavedAllocationReason(capabilities, allocation, repositoryType);
  if (reason) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: reason });
  }
}
