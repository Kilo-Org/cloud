import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import PROVIDERS from '@/lib/ai-gateway/providers/provider-definitions';
import { getRuntimeGatewayRoutingConfig } from '@/lib/ai-gateway/providers/routing-config';
import {
  passesRoutingPercentage,
  type RoutingCohort,
} from '@/lib/ai-gateway/providers/routing-percentage';
import type { Provider } from '@/lib/ai-gateway/providers/types';
import { PERPLEXITY_KIMI_PUBLIC_ID } from '@/lib/ai-gateway/providers/moonshotai';
import { FRIENDLI_GLM_PUBLIC_ID } from '@/lib/ai-gateway/providers/zai';

type PartnerRoute = {
  provider: Provider;
  cohort: Exclude<RoutingCohort, 'vercel'>;
};

export type PercentageRoutedPartnerInput = {
  requestedModel: string;
  request: GatewayRequest;
  randomSeed: string;
  sourceProviderId: Provider['id'];
  hasUserByok: boolean;
};

const PARTNER_ROUTES: Readonly<Record<string, PartnerRoute>> = {
  [FRIENDLI_GLM_PUBLIC_ID]: {
    provider: PROVIDERS.FRIENDLI_GLM,
    cohort: 'friendli',
  },
  [PERPLEXITY_KIMI_PUBLIC_ID]: {
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

function getEligiblePartnerRoute(input: PercentageRoutedPartnerInput): PartnerRoute | null {
  const { requestedModel, request, sourceProviderId, hasUserByok } = input;
  const route = PARTNER_ROUTES[requestedModel];
  if (
    !route ||
    route.provider.apiKey.trim().length === 0 ||
    hasUserByok ||
    (sourceProviderId !== 'vercel' && sourceProviderId !== 'openrouter') ||
    hasCustomizedProviderOptions(request) ||
    !route.provider.supportedChatApis.includes(request.kind)
  ) {
    return null;
  }
  return route;
}

export async function getPercentageRoutedPartnerProvider(
  input: PercentageRoutedPartnerInput
): Promise<Provider | null> {
  if (!getEligiblePartnerRoute(input)) return null;
  const routingConfig = await getRuntimeGatewayRoutingConfig();
  return selectPercentageRoutedPartnerProvider(input, routingConfig);
}

export function selectPercentageRoutedPartnerProvider(
  input: PercentageRoutedPartnerInput,
  routingConfig: Awaited<ReturnType<typeof getRuntimeGatewayRoutingConfig>>
): Provider | null {
  const route = getEligiblePartnerRoute(input);
  if (!route) return null;

  const percentage = routingConfig[route.cohort];
  return passesRoutingPercentage(route.cohort, input.randomSeed, percentage)
    ? route.provider
    : null;
}
