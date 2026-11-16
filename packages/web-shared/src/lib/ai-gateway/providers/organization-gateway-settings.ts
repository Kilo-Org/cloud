import type { OrganizationDataRegion, OrganizationSettings } from '@kilocode/db/schema-types';
import type { OrganizationFeatures } from '@kilocode/web-shared/lib/ai-gateway/gateway-config';
import { isOrganizationFeatureEnabled } from '@kilocode/web-shared/lib/ai-gateway/organization-features';
import type { OrganizationPlan } from '@kilocode/web-shared/lib/organizations/organization-types';
import type { BYOKResult, Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { getDomain } from 'tldts';

export type ManagedGatewayId = 'openrouter';

/**
 * The organization's advanced gateway policies, as they apply to requests Kilo pays for. A user's
 * own BYOK key (a provider key, or an OpenRouter or Vercel AI Gateway key) is exempt from both,
 * and so are autocomplete (FIM) and edit completions, which never call these handlers' policy.
 *
 * Neither policy changes the model lists the model endpoints return. That is a deliberate
 * limitation until end users ask for it; see `packages/web-shared/AGENTS.md`.
 */
export type OrganizationGatewaySettings = {
  /**
   * OpenRouter may not serve a request Kilo pays for. Set when the organization disabled it, and
   * whenever an inference region is set, since OpenRouter cannot pin a region.
   */
  openRouterDisabled: boolean;
  /**
   * Requests Kilo pays for run only through Kilo's Vercel AI Gateway account, pinned to this
   * region. Every other provider is refused for them.
   */
  dataRegion: OrganizationDataRegion | null;
};

export const NO_ORGANIZATION_GATEWAY_SETTINGS: OrganizationGatewaySettings = {
  openRouterDisabled: false,
  dataRegion: null,
};

/**
 * The organization's gateway settings that take effect. They are an enterprise feature: an
 * organization on another plan, including one downgraded from enterprise, keeps its stored
 * settings but they do not apply. The `gateway_settings` organization feature gates the rollout.
 */
export function getOrganizationGatewaySettings(
  features: OrganizationFeatures,
  organization: {
    id: string;
    plan: OrganizationPlan | undefined;
    settings: OrganizationSettings | undefined;
  }
): OrganizationGatewaySettings {
  const { id, plan, settings } = organization;
  if (
    !settings ||
    plan !== 'enterprise' ||
    !isOrganizationFeatureEnabled(features, 'gateway_settings', id)
  ) {
    return NO_ORGANIZATION_GATEWAY_SETTINGS;
  }
  const dataRegion = settings.data_region ?? null;
  return {
    openRouterDisabled: !!settings.disable_openrouter || dataRegion !== null,
    dataRegion,
  };
}

export function getManagedGatewayFromUrl(url: string): ManagedGatewayId | undefined {
  const hostname = URL.parse(url)?.hostname;
  if (!hostname) return undefined;
  switch (getDomain(hostname, { allowPrivateDomains: false })) {
    case 'openrouter.ai':
      return 'openrouter';
    default:
      return undefined;
  }
}

/** One way to serve a request, as far as the gateway settings are concerned. */
export type GatewayPolicyRoute = {
  provider: Pick<Provider, 'type' | 'apiUrl'>;
  userByok: readonly BYOKResult[] | null;
};

function isUserByokRoute(route: Pick<GatewayPolicyRoute, 'userByok'>): boolean {
  return !!route.userByok && route.userByok.length > 0;
}

/**
 * Why the gateway settings refuse a route, or null when it may serve the request. A user's own
 * BYOK key is never refused. Otherwise an inference region admits only Kilo's Vercel AI Gateway,
 * and a disabled OpenRouter refuses OpenRouter and any upstream URL on its domain.
 */
export function getGatewaySettingsRefusal(
  settings: OrganizationGatewaySettings,
  route: GatewayPolicyRoute
):
  | { kind: 'inference-region'; region: OrganizationDataRegion }
  | { kind: ManagedGatewayId }
  | null {
  if (isUserByokRoute(route)) return null;
  if (settings.dataRegion && route.provider.type !== 'vercel') {
    return { kind: 'inference-region', region: settings.dataRegion };
  }
  if (
    settings.openRouterDisabled &&
    (route.provider.type === 'openrouter' ||
      getManagedGatewayFromUrl(route.provider.apiUrl) === 'openrouter')
  ) {
    return { kind: 'openrouter' };
  }
  return null;
}

/** The region to pin the route's inference to: only Kilo's own Vercel AI Gateway route is pinned. */
export function getRouteInferenceRegion(
  settings: OrganizationGatewaySettings,
  route: Pick<GatewayPolicyRoute, 'userByok'> & { provider: Pick<Provider, 'type'> }
): OrganizationDataRegion | null {
  if (isUserByokRoute(route) || route.provider.type !== 'vercel') return null;
  return settings.dataRegion;
}
