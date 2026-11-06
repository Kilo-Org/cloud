import type { OrganizationDataRegion, OrganizationSettings } from '@kilocode/db/schema-types';
import type { OrganizationFeatures } from '@kilocode/web-shared/lib/ai-gateway/gateway-config';
import {
  getRuntimeOrganizationFeatures,
  isOrganizationFeatureEnabled,
} from '@kilocode/web-shared/lib/ai-gateway/organization-features';
import type { Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { getDomain } from 'tldts';

export type ManagedGatewayId = 'openrouter' | 'vercel';

export type OrganizationGatewaySettings = {
  disabledGateways: ReadonlySet<ManagedGatewayId>;
  dataRegion: OrganizationDataRegion | null;
};

export const NO_ORGANIZATION_GATEWAY_SETTINGS: OrganizationGatewaySettings = {
  disabledGateways: new Set(),
  dataRegion: null,
};

/** The organization's gateway settings that its enabled organization features let take effect. */
export function getOrganizationGatewaySettings(
  features: OrganizationFeatures,
  organizationId: string,
  settings: OrganizationSettings | undefined
): OrganizationGatewaySettings {
  if (!settings || !isOrganizationFeatureEnabled(features, 'gateway_settings', organizationId)) {
    return NO_ORGANIZATION_GATEWAY_SETTINGS;
  }
  const disabledGateways = new Set<ManagedGatewayId>();
  if (settings.disable_openrouter) disabledGateways.add('openrouter');
  if (settings.disable_vercel_ai_gateway) disabledGateways.add('vercel');
  return { disabledGateways, dataRegion: settings.data_region ?? null };
}

export function getManagedGatewayFromUrl(url: string): ManagedGatewayId | undefined {
  const hostname = URL.parse(url)?.hostname;
  if (!hostname) return undefined;
  switch (getDomain(hostname, { allowPrivateDomains: false })) {
    case 'openrouter.ai':
      return 'openrouter';
    case 'vercel.sh':
      return 'vercel';
    default:
      return undefined;
  }
}

export function isManagedGatewayDisabled(
  settings: OrganizationGatewaySettings,
  providerType: Provider['type']
): providerType is ManagedGatewayId {
  return (
    (providerType === 'openrouter' || providerType === 'vercel') &&
    settings.disabledGateways.has(providerType)
  );
}

/**
 * The organization's gateway policy for a request that already read the organization's balance and
 * settings through `readGatewayBalance` or `getBalanceAndOrgSettings`. A caller without an
 * organization has no policy to apply.
 */
export async function resolveOrganizationGatewaySettings(
  organizationId: string | undefined,
  settings: OrganizationSettings | undefined
): Promise<OrganizationGatewaySettings> {
  if (!organizationId) return NO_ORGANIZATION_GATEWAY_SETTINGS;
  return getOrganizationGatewaySettings(
    await getRuntimeOrganizationFeatures(),
    organizationId,
    settings
  );
}

/**
 * The managed gateway this request would leave through, when the organization has disabled it.
 * Checks the provider type and the gateway host of the upstream URL, so a provider with a generic
 * type that targets a managed gateway is refused as well.
 */
export function disabledManagedGateway(
  settings: OrganizationGatewaySettings,
  providerType: Provider['type'],
  upstreamUrl: string
): ManagedGatewayId | undefined {
  if (isManagedGatewayDisabled(settings, providerType)) return providerType;
  const gatewayByDomain = getManagedGatewayFromUrl(upstreamUrl);
  return gatewayByDomain && isManagedGatewayDisabled(settings, gatewayByDomain)
    ? gatewayByDomain
    : undefined;
}
