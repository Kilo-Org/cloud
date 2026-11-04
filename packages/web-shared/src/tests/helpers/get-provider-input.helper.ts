import type { GetProviderInput } from '@kilocode/web-shared/lib/ai-gateway/providers/get-provider';

type RoutingPolicyHook =
  | 'getRoutingProviderConfig'
  | 'getAllowedProviders'
  | 'isDirectByokProviderAllowed'
  | 'organizationDisabledVercelAiGateway';

/**
 * A `getProvider` input for an owner without an organization policy, unless the test overrides a
 * hook. Like the LLM proxy handler, the provider routing settings default to the request's own.
 */
export function getProviderInput(
  input: Omit<GetProviderInput, RoutingPolicyHook> &
    Partial<Pick<GetProviderInput, RoutingPolicyHook>>
): GetProviderInput {
  return {
    getRoutingProviderConfig: async () => input.request.body.provider,
    getAllowedProviders: async () => undefined,
    isDirectByokProviderAllowed: async () => true,
    organizationDisabledVercelAiGateway: false,
    ...input,
  };
}
