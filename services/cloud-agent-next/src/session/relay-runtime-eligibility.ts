import { TRPCError } from '@trpc/server';
import { normalizeSandboxAllocation } from '@kilocode/worker-utils/sandbox-allocation';
import { controlPlaneSandboxPlacement } from '../sandbox-placement.js';
import { ProviderCreationError } from '../sandbox-control/provider.js';
import { RetiredSandboxProviderError } from '../sandbox-control/retired-cloudflare-provider.js';
import { newSandboxHarnessFromFacts, selectStartup } from '../sandbox-control/startup-selection.js';
import type { AgentSandboxProvider, Env } from '../types.js';
import { requestedSandboxAllocation } from './sandbox-allocation-resolution.js';
import type { SessionCreateRequest } from './session-requests.js';

export function isRelayRuntimeEligible(
  input: SessionCreateRequest,
  ctx: { env: Env; userId: string },
  options?: { billingOrigin?: string }
): boolean {
  if (input.chat?.transport !== 'relay') return true;
  const allocation = requestedSandboxAllocation(input);
  const placementKnown = allocation !== undefined || input.savedSandboxAllocation !== undefined;
  try {
    const placements = placementKnown
      ? [
          controlPlaneSandboxPlacement({
            env: ctx.env,
            userId: ctx.userId,
            orgId: input.options?.kilocodeOrganizationId,
            codeReview: options?.billingOrigin === 'code-review',
            sandboxAllocation:
              allocation === undefined ? undefined : normalizeSandboxAllocation(allocation),
            requestedAllocation: allocation,
          }),
        ]
      : (['cloudflare-containers', 'vercel'] satisfies AgentSandboxProvider[]).map(provider => ({
          provider,
          sandboxKind: 'isolated' as const,
        }));
    return placements.every(placement => {
      const harness = newSandboxHarnessFromFacts(ctx.env, placement.provider, {
        preparingRoutes: [
          {
            orgId: input.options?.kilocodeOrganizationId,
            billingOrigin: options?.billingOrigin,
          },
        ],
        isolatedNativeSandbox:
          placement.sandboxKind === 'isolated' || placement.sandboxKind === 'isolated-standard',
      });
      if (harness !== 'kilo2') return false;
      selectStartup(ctx.env, placement.provider, undefined, harness);
      return true;
    });
  } catch (error) {
    if (error instanceof ProviderCreationError || error instanceof RetiredSandboxProviderError) {
      return false;
    }
    throw error;
  }
}

export function relayRuntimeIneligibleError(): TRPCError {
  return new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: 'RELAY_RUNTIME_INELIGIBLE',
    cause: { error: 'RELAY_RUNTIME_INELIGIBLE', retryable: false },
  });
}
