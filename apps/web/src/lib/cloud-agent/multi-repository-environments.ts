import { isFeatureFlagEnabled } from '@kilocode/web-shared/lib/posthog-feature-flags';
import {
  allocationSupportsMultiRepository,
  type SelectableSandboxAllocation,
} from '@kilocode/worker-utils/sandbox-allocation';
import { TRPCError } from '@trpc/server';
import type { EnvironmentOwner } from '@kilocode/cloud-agent-profile';

/**
 * PostHog flag that lets an owner create and edit multi-repository (V2)
 * environments. The distinct id is the organization id for an organization owner
 * and the user id for a personal owner.
 */
export const MULTI_REPOSITORY_ENVIRONMENTS_FLAG = 'cloud-agent-multi-repository-environments';

export function isMultiRepositoryEnvironmentsEnabled(owner: EnvironmentOwner): Promise<boolean> {
  return isFeatureFlagEnabled(MULTI_REPOSITORY_ENVIRONMENTS_FLAG, owner.id);
}

export async function assertMultiRepositoryEnvironmentsEnabled(
  owner: EnvironmentOwner
): Promise<void> {
  if (!(await isMultiRepositoryEnvironmentsEnabled(owner))) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Multi-repository environments are not enabled for this account',
    });
  }
}

/**
 * A V2 session needs an isolated Cloudflare sandbox: one workspace holds every
 * repository. The shared sandbox and Vercel are rejected when the environment is
 * saved. An unset allocation is checked when the session starts.
 */
export function assertAllocationSupportsMultiRepository(
  allocation: SelectableSandboxAllocation | null | undefined
): void {
  if (allocation === null || allocation === undefined) return;
  if (!allocationSupportsMultiRepository(allocation)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'A multi-repository environment needs an isolated Cloudflare sandbox allocation',
    });
  }
}
