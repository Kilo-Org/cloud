import {
  getSandboxAllocation,
  isSelectableSandboxAllocation,
  normalizeSandboxAllocation,
  sandboxAllocationSchema,
  sandboxAllocationInputSchema,
  type SandboxSelectionCapabilities,
  type SandboxAllocation,
} from '@kilocode/worker-utils/sandbox-allocation';
import { newSandboxHarnessFromFacts } from '../sandbox-control/startup-selection.js';
import { controlPlaneSandboxPlacement } from '../sandbox-placement.js';
import type { Env } from '../types.js';

export function relayChatForBrowserPrepare(
  env: Env,
  owner: { userId: string; orgId?: string },
  capabilities: SandboxSelectionCapabilities,
  environment: { status: string; sandboxAllocation?: string | null }
): boolean {
  if (!env.RUNTIME_RELEASE_DESCRIPTOR_KILO2 || !capabilities.defaultDestination) return false;
  if (environment.status !== 'none' && environment.status !== 'match') return false;
  const allocations: Array<SandboxAllocation | undefined> = [undefined];
  for (const destination of [capabilities.defaultDestination, capabilities.effectiveDestination]) {
    if (!destination) continue;
    const parsed = sandboxAllocationInputSchema.safeParse(destination);
    if (!parsed.success) return false;
    const allocation = getSandboxAllocation(parsed.data);
    if (allocation === undefined) return false;
    allocations.push(allocation);
  }
  if (capabilities.enabled) {
    for (const option of capabilities.options) {
      if (!option.unavailableReason && !option.repositoryUnavailableReason) {
        const allocation = getSandboxAllocation(option.allocation);
        if (allocation === undefined) return false;
        allocations.push(allocation);
      }
    }
  }
  if (environment.status === 'match' && environment.sandboxAllocation != null) {
    const allocation = sandboxAllocationSchema.safeParse(environment.sandboxAllocation);
    if (!allocation.success || !isSelectableSandboxAllocation(allocation.data)) return false;
    allocations.push(allocation.data);
  }
  try {
    return allocations.every(allocation => {
      const placement = controlPlaneSandboxPlacement({
        env,
        ...owner,
        codeReview: false,
        ...(allocation
          ? {
              sandboxAllocation: normalizeSandboxAllocation(allocation),
              requestedAllocation: allocation,
            }
          : {}),
      });
      return (
        newSandboxHarnessFromFacts(env, placement.provider, {
          isolatedNativeSandbox:
            placement.sandboxKind === 'isolated' || placement.sandboxKind === 'isolated-standard',
          preparingRoutes: [{ orgId: owner.orgId, billingOrigin: 'cloud-agent-web' }],
        }) === 'kilo2'
      );
    });
  } catch {
    return false;
  }
}
