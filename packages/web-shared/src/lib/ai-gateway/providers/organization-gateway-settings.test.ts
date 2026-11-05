import { describe, expect, it } from '@jest/globals';
import { DEFAULT_ORGANIZATION_FEATURES } from '@kilocode/web-shared/lib/ai-gateway/gateway-config';
import {
  getOrganizationGatewaySettings,
  isManagedGatewayDisabled,
} from './organization-gateway-settings';

const organizationId = '9d278969-5453-4ae3-a51f-a8d2274a7b56';

describe('getOrganizationGatewaySettings', () => {
  it('applies the settings while the gateway settings feature is enabled', () => {
    const settings = getOrganizationGatewaySettings(
      { ...DEFAULT_ORGANIZATION_FEATURES, gateway_settings: [organizationId] },
      organizationId.toUpperCase(),
      { disable_openrouter: true, disable_vercel_ai_gateway: true, data_region: 'eu' }
    );

    expect([...settings.disabledGateways].sort()).toEqual(['openrouter', 'vercel']);
    expect(settings.dataRegion).toBe('eu');
    expect(isManagedGatewayDisabled(settings, 'openrouter')).toBe(true);
    expect(isManagedGatewayDisabled(settings, 'direct-byok')).toBe(false);
  });

  it('ignores the settings while the feature is not enabled for the organization', () => {
    const settings = getOrganizationGatewaySettings(DEFAULT_ORGANIZATION_FEATURES, organizationId, {
      disable_openrouter: true,
      data_region: 'us',
    });

    expect(settings.disabledGateways.size).toBe(0);
    expect(settings.dataRegion).toBeNull();
  });
});
