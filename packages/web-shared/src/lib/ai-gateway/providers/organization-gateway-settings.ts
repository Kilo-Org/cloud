import type { OrganizationDataRegion, OrganizationSettings } from '@kilocode/db/schema-types';
import type { OrganizationFeatures } from '@kilocode/web-shared/lib/ai-gateway/gateway-config';
import { isOrganizationFeatureEnabled } from '@kilocode/web-shared/lib/ai-gateway/organization-features';
import type { Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';

export type ManagedGatewayId = 'openrouter' | 'vercel';

export type OrganizationGatewaySettings = {
  disabledGateways: ReadonlySet<ManagedGatewayId>;
  dataRegion: OrganizationDataRegion | null;
};

/** The organization's gateway settings that its enabled organization features let take effect. */
export function getOrganizationGatewaySettings(
  features: OrganizationFeatures,
  organizationId: string | null | undefined,
  settings: OrganizationSettings | undefined
): OrganizationGatewaySettings {
  const disabledGateways = new Set<ManagedGatewayId>();
  if (isOrganizationFeatureEnabled(features, 'gateway_disable_toggles', organizationId)) {
    if (settings?.disable_openrouter) disabledGateways.add('openrouter');
    if (settings?.disable_vercel_ai_gateway) disabledGateways.add('vercel');
  }
  const dataRegion = isOrganizationFeatureEnabled(features, 'data_region', organizationId)
    ? (settings?.data_region ?? null)
    : null;
  return { disabledGateways, dataRegion };
}

export function isManagedGatewayDisabled(
  settings: OrganizationGatewaySettings,
  providerId: Provider['id']
): providerId is ManagedGatewayId {
  return (
    (providerId === 'openrouter' || providerId === 'vercel') &&
    settings.disabledGateways.has(providerId)
  );
}

/**
 * Pins Vercel AI Gateway inference to the data region with
 * `providerOptions.gateway.inferenceRegion`, which fails the request instead of leaving the region
 * (https://vercel.com/docs/ai-gateway/security-and-compliance/regional-inference). OpenRouter's
 * regional hosts need a Business plan we do not have, so OpenRouter and other providers are unchanged.
 */
export function withDataRegion(provider: Provider, dataRegion: OrganizationDataRegion): Provider {
  if (provider.id === 'vercel') {
    return {
      ...provider,
      async transformRequest(context) {
        await provider.transformRequest(context);
        const body = context.request.body;
        body.providerOptions = {
          ...body.providerOptions,
          gateway: {
            ...body.providerOptions?.gateway,
            inferenceRegion: { scope: 'zone', geoRegion: dataRegion },
          },
        };
      },
    };
  }
  return provider;
}
