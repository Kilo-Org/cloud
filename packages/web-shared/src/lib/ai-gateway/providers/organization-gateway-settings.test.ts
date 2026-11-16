import { describe, expect, it } from '@jest/globals';
import { DEFAULT_ORGANIZATION_FEATURES } from '@kilocode/web-shared/lib/ai-gateway/gateway-config';
import {
  getGatewaySettingsRefusal,
  getManagedGatewayFromUrl,
  getOrganizationGatewaySettings,
  getRouteInferenceRegion,
  NO_ORGANIZATION_GATEWAY_SETTINGS,
  type GatewayPolicyRoute,
  type OrganizationGatewaySettings,
} from './organization-gateway-settings';

const organizationId = '9d278969-5453-4ae3-a51f-a8d2274a7b56';

describe('getManagedGatewayFromUrl', () => {
  it.each([
    ['https://openrouter.ai/api/v1', 'openrouter'],
    ['https://api.openrouter.ai/v1', 'openrouter'],
    ['https://OPENROUTER.AI.:8443/api/v1', 'openrouter'],
    ['https://%6fpenrouter.ai/api/v1', 'openrouter'],
    ['https://user:password@openrouter.ai/api/v1', 'openrouter'],
    ['https://ai-gateway.vercel.sh/v1', undefined],
    ['https://vercel.sh/v1', undefined],
    ['https://other.VERCEL.SH.:8443/v1', undefined],
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
  const enabled = { ...DEFAULT_ORGANIZATION_FEATURES, gateway_settings: [organizationId] };

  it('applies the settings of an enterprise organization while the feature is enabled', () => {
    const settings = getOrganizationGatewaySettings(enabled, {
      id: organizationId.toUpperCase(),
      plan: 'enterprise',
      settings: { disable_openrouter: true, data_region: 'eu' },
    });

    expect(settings).toEqual({ openRouterDisabled: true, dataRegion: 'eu' });
  });

  it('disables OpenRouter without an inference region when only that setting is on', () => {
    expect(
      getOrganizationGatewaySettings(enabled, {
        id: organizationId,
        plan: 'enterprise',
        settings: { disable_openrouter: true },
      })
    ).toEqual({ openRouterDisabled: true, dataRegion: null });
  });

  it('applies neither setting when the organization set none', () => {
    expect(
      getOrganizationGatewaySettings(enabled, {
        id: organizationId,
        plan: 'enterprise',
        settings: {},
      })
    ).toEqual(NO_ORGANIZATION_GATEWAY_SETTINGS);
  });

  it('implies a disabled OpenRouter from an inference region', () => {
    expect(
      getOrganizationGatewaySettings(enabled, {
        id: organizationId,
        plan: 'enterprise',
        settings: { disable_openrouter: false, data_region: 'jp' },
      })
    ).toEqual({ openRouterDisabled: true, dataRegion: 'jp' });
  });

  it.each(['teams', undefined] as const)(
    'ignores the settings of an organization on the %s plan',
    plan => {
      expect(
        getOrganizationGatewaySettings(enabled, {
          id: organizationId,
          plan,
          settings: { disable_openrouter: true, data_region: 'eu' },
        })
      ).toEqual(NO_ORGANIZATION_GATEWAY_SETTINGS);
    }
  );

  it('ignores the settings while the feature is not enabled for the organization', () => {
    expect(
      getOrganizationGatewaySettings(DEFAULT_ORGANIZATION_FEATURES, {
        id: organizationId,
        plan: 'enterprise',
        settings: { disable_openrouter: true, data_region: 'us' },
      })
    ).toEqual(NO_ORGANIZATION_GATEWAY_SETTINGS);
  });

  it('ignores an organization without settings', () => {
    expect(
      getOrganizationGatewaySettings(enabled, {
        id: organizationId,
        plan: 'enterprise',
        settings: undefined,
      })
    ).toEqual(NO_ORGANIZATION_GATEWAY_SETTINGS);
  });
});

describe('gateway settings routes', () => {
  const openRouterDisabled: OrganizationGatewaySettings = {
    openRouterDisabled: true,
    dataRegion: null,
  };
  const euRegion: OrganizationGatewaySettings = { openRouterDisabled: true, dataRegion: 'eu' };
  const userKey = [{ decryptedAPIKey: 'sk-user', providerId: 'openai' }] as const;

  const openRouter = {
    provider: { type: 'openrouter', apiUrl: 'https://openrouter.ai/api/v1' },
    userByok: null,
  } as const satisfies GatewayPolicyRoute;
  const vercel = {
    provider: { type: 'vercel', apiUrl: 'https://ai-gateway.vercel.sh/v1' },
    userByok: null,
  } as const satisfies GatewayPolicyRoute;
  const customAtOpenRouter = {
    provider: { type: 'custom', apiUrl: 'https://openrouter.ai/api/v1' },
    userByok: null,
  } as const satisfies GatewayPolicyRoute;
  const custom = {
    provider: { type: 'custom', apiUrl: 'https://llm.example.com/v1' },
    userByok: null,
  } as const satisfies GatewayPolicyRoute;
  const claudeBilling = {
    provider: { type: 'claude-billing', apiUrl: 'https://api.anthropic.com/v1' },
    userByok: null,
  } as const satisfies GatewayPolicyRoute;

  describe('getGatewaySettingsRefusal', () => {
    it.each([
      ['openrouter', openRouter],
      ['vercel', vercel],
      ['custom', custom],
      ['claude-billing', claudeBilling],
    ] as const)('admits a %s route without gateway settings', (_name, route) => {
      expect(getGatewaySettingsRefusal(NO_ORGANIZATION_GATEWAY_SETTINGS, route)).toBeNull();
    });

    it.each([
      ['an openrouter provider', openRouter],
      ['a custom provider at an openrouter.ai URL', customAtOpenRouter],
    ] as const)('refuses %s when OpenRouter is disabled', (_name, route) => {
      expect(getGatewaySettingsRefusal(openRouterDisabled, route)).toEqual({ kind: 'openrouter' });
    });

    it.each([
      ['vercel', vercel],
      ['custom', custom],
      ['claude-billing', claudeBilling],
    ] as const)('admits a %s route when only OpenRouter is disabled', (_name, route) => {
      expect(getGatewaySettingsRefusal(openRouterDisabled, route)).toBeNull();
    });

    it.each([
      ['openrouter', openRouter],
      ['custom', custom],
      ['custom at openrouter.ai', customAtOpenRouter],
      ['claude-billing', claudeBilling],
    ] as const)('refuses a %s route under an inference region', (_name, route) => {
      expect(getGatewaySettingsRefusal(euRegion, route)).toEqual({
        kind: 'inference-region',
        region: 'eu',
      });
    });

    it('admits Kilo’s Vercel AI Gateway route under an inference region', () => {
      expect(getGatewaySettingsRefusal(euRegion, vercel)).toBeNull();
    });

    it.each([
      ['an openrouter key', { type: 'openrouter', apiUrl: 'https://openrouter.ai/api/v1' }],
      ['a direct-byok provider', { type: 'direct-byok', apiUrl: 'https://api.openai.com/v1' }],
      ['a custom provider', { type: 'custom', apiUrl: 'https://openrouter.ai/api/v1' }],
    ] as const)('never refuses %s carrying the user’s own key', (_name, provider) => {
      const route = { provider, userByok: userKey } as GatewayPolicyRoute;

      expect(getGatewaySettingsRefusal(euRegion, route)).toBeNull();
      expect(getGatewaySettingsRefusal(openRouterDisabled, route)).toBeNull();
    });

    it('refuses a route whose user key list is empty like a Kilo-paid one', () => {
      expect(
        getGatewaySettingsRefusal(openRouterDisabled, { ...openRouter, userByok: [] })
      ).toEqual({ kind: 'openrouter' });
    });
  });

  describe('getRouteInferenceRegion', () => {
    it('pins Kilo’s Vercel AI Gateway route to the region', () => {
      expect(getRouteInferenceRegion(euRegion, vercel)).toBe('eu');
    });

    it('does not pin a Vercel route carrying the user’s own key', () => {
      expect(getRouteInferenceRegion(euRegion, { ...vercel, userByok: userKey })).toBeNull();
    });

    it('does not pin a route that is not on Vercel', () => {
      expect(getRouteInferenceRegion(euRegion, openRouter)).toBeNull();
    });

    it('pins nothing without an inference region', () => {
      expect(getRouteInferenceRegion(openRouterDisabled, vercel)).toBeNull();
    });
  });
});
