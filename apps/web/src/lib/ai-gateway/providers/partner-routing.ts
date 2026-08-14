import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import PROVIDERS from '@/lib/ai-gateway/providers/provider-definitions';
import { getRuntimeGatewayRoutingConfig } from '@/lib/ai-gateway/providers/routing-config';
import {
  passesRoutingPercentage,
  type RoutingCohort,
} from '@/lib/ai-gateway/providers/routing-percentage';
import type { Provider } from '@/lib/ai-gateway/providers/types';

type PartnerRoute = {
  provider: Provider;
  cohort: Exclude<RoutingCohort, 'vercel'>;
};

const PARTNER_ROUTES: Readonly<Record<string, PartnerRoute>> = {
  'z-ai/glm-5.2': {
    provider: PROVIDERS.FRIENDLI_GLM,
    cohort: 'friendli',
  },
  'moonshotai/kimi-k3': {
    provider: PROVIDERS.PERPLEXITY_KIMI,
    cohort: 'perplexity',
  },
};

export function hasCustomizedProviderOptions(request: GatewayRequest) {
  const provider = request.body.provider;
  // Direct partners do not support advanced provider routing, so customized options cannot be
  // forwarded safely even when they look compatible at face value. An empty object is harmless.
  return provider !== undefined && Object.keys(provider).length > 0;
}

function getEligiblePartnerRoute(
  requestedModel: string,
  request: GatewayRequest
): PartnerRoute | null {
  const route = PARTNER_ROUTES[requestedModel];
  if (
    !route ||
    hasCustomizedProviderOptions(request) ||
    !route.provider.supportedChatApis.includes(request.kind)
  ) {
    return null;
  }
  return route;
}

export async function getPercentageRoutedPartnerProvider(
  requestedModel: string,
  request: GatewayRequest,
  randomSeed: string
): Promise<Provider | null> {
  if (!getEligiblePartnerRoute(requestedModel, request)) return null;
  const routingConfig = await getRuntimeGatewayRoutingConfig();
  return selectPercentageRoutedPartnerProvider(requestedModel, request, randomSeed, routingConfig);
}

export function selectPercentageRoutedPartnerProvider(
  requestedModel: string,
  request: GatewayRequest,
  randomSeed: string,
  routingConfig: Awaited<ReturnType<typeof getRuntimeGatewayRoutingConfig>>
): Provider | null {
  const route = getEligiblePartnerRoute(requestedModel, request);
  if (!route) return null;

  const percentage = routingConfig[route.cohort];
  return passesRoutingPercentage(route.cohort, randomSeed, percentage) ? route.provider : null;
}
