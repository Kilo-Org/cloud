import type {
  GatewayRequest,
  OpenRouterProviderConfig,
} from '@/lib/ai-gateway/providers/openrouter/types';
import PROVIDERS from '@/lib/ai-gateway/providers/provider-definitions';
import { KIMI_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/moonshotai';
import { GLM_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/zai';
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
  [GLM_CURRENT_MODEL_ID]: {
    provider: PROVIDERS.FRIENDLI_GLM,
    cohort: 'friendli',
  },
  [KIMI_CURRENT_MODEL_ID]: {
    provider: PROVIDERS.PERPLEXITY_KIMI,
    cohort: 'perplexity',
  },
};

function getEligiblePartnerRoute(
  requestedModel: string,
  request: GatewayRequest
): PartnerRoute | null {
  const route = PARTNER_ROUTES[requestedModel];
  if (
    !route ||
    request.body.provider !== undefined ||
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

export function isPartnerProviderAllowed(
  provider: Provider,
  providerConfig: OpenRouterProviderConfig | undefined
) {
  if (!providerConfig) return true;
  return (
    (!providerConfig.only || providerConfig.only.includes(provider.id)) &&
    (!providerConfig.ignore || !providerConfig.ignore.includes(provider.id))
  );
}
