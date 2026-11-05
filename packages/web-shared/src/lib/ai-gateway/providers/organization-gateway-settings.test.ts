import { describe, expect, it } from '@jest/globals';
import { DEFAULT_ORGANIZATION_FEATURES } from '@kilocode/web-shared/lib/ai-gateway/gateway-config';
import {
  getManagedGatewayFromUrl,
  getOrganizationGatewaySettings,
  isManagedGatewayDisabled,
} from './organization-gateway-settings';

const organizationId = '9d278969-5453-4ae3-a51f-a8d2274a7b56';

describe('getManagedGatewayFromUrl', () => {
  it.each([
    ['https://openrouter.ai/api/v1', 'openrouter'],
    ['https://api.openrouter.ai/v1', 'openrouter'],
    ['https://OPENROUTER.AI.:8443/api/v1', 'openrouter'],
    ['https://%6fpenrouter.ai/api/v1', 'openrouter'],
    ['https://user:password@openrouter.ai/api/v1', 'openrouter'],
    ['https://ai-gateway.vercel.sh/v1', 'vercel'],
    ['https://vercel.sh/v1', 'vercel'],
    ['https://other.VERCEL.SH.:8443/v1', 'vercel'],
    ['https://openrouter.ai.attacker.example/v1', undefined],
    ['https://notopenrouter.ai/v1', undefined],
    ['https://openrouter.ai@api.example.com/v1', undefined],
    ['https://ai-gateway.vercel.sh.attacker.example/v1', undefined],
    ['https://notvercel.sh/v1', undefined],
    ['https://openrouter.ai.example.co.uk/v1', undefined],
    ['http://localhost:3000/v1', undefined],
    ['http://127.0.0.1/v1', undefined],
    ['http://[::1]/v1', undefined],
    ['/openrouter.ai/api/v1', undefined],
    ['openrouter.ai', undefined],
    ['https://openrouter.ai:invalid/api/v1', undefined],
    ['not a URL', undefined],
    ['', undefined],
  ] as const)('maps %s to %s', (url, expectedGateway) => {
    expect(getManagedGatewayFromUrl(url)).toBe(expectedGateway);
  });
});

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
