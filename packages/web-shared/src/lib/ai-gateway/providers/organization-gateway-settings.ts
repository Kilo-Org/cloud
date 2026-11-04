import type { OrganizationDataRegion, OrganizationSettings } from '@kilocode/db/schema-types';
import type { OrganizationFeatures } from '@kilocode/web-shared/lib/ai-gateway/gateway-config';
import { isOrganizationFeatureEnabled } from '@kilocode/web-shared/lib/ai-gateway/organization-features';
import type { Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';

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

export function isManagedGatewayDisabled(
  settings: OrganizationGatewaySettings,
  providerType: Provider['type']
): providerType is ManagedGatewayId {
  return (
    (providerType === 'openrouter' || providerType === 'vercel') &&
    settings.disabledGateways.has(providerType)
  );
}
