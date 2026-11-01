import { describe, expect, it, jest } from '@jest/globals';
import { DEFAULT_ORGANIZATION_FEATURES } from '@kilocode/web-shared/lib/ai-gateway/gateway-config';
import type {
  Provider,
  TransformRequestContext,
} from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import {
  getOrganizationGatewaySettings,
  isManagedGatewayDisabled,
  withDataRegion,
} from './organization-gateway-settings';

const organizationId = '00000000-0000-4000-8000-000000000001';

const allFeatures = {
  ...DEFAULT_ORGANIZATION_FEATURES,
  gateway_disable_toggles: [organizationId],
  data_region: [organizationId],
};

function makeProvider(id: Provider['id']): Provider {
  return {
    id,
    apiUrl: 'https://upstream.example.com/v1',
    apiUrlOverrides: {},
    disableUrlSuffix: false,
    apiKey: 'key',
    apiKeyHeader: null,
    supportedChatApis: ['chat_completions'],
    responseTransforms: null,
    transformRequest: jest.fn(async () => {}),
  };
}

function makeContext(provider: Provider, request: GatewayRequest): TransformRequestContext {
  return {
    provider,
    model: 'anthropic/claude-sonnet-5',
    request,
    originalHeaders: {} as TransformRequestContext['originalHeaders'],
    extraHeaders: {},
    userByok: null,
    kilo_user_id: 'user-1',
    organization_id: organizationId,
    session_id: null,
  };
}

describe('getOrganizationGatewaySettings', () => {
  it('applies the settings of enabled features', () => {
    const settings = getOrganizationGatewaySettings(allFeatures, organizationId, {
      disable_openrouter: true,
      disable_vercel_ai_gateway: true,
      data_region: 'eu',
    });

    expect([...settings.disabledGateways].sort()).toEqual(['openrouter', 'vercel']);
    expect(settings.dataRegion).toBe('eu');
    expect(isManagedGatewayDisabled(settings, 'openrouter')).toBe(true);
    expect(isManagedGatewayDisabled(settings, 'direct-byok')).toBe(false);
  });

  it('ignores the settings of features that are not enabled for the organization', () => {
    const settings = getOrganizationGatewaySettings(DEFAULT_ORGANIZATION_FEATURES, organizationId, {
      disable_openrouter: true,
      data_region: 'us',
    });

    expect(settings.disabledGateways.size).toBe(0);
    expect(settings.dataRegion).toBeNull();
  });
});

describe('withDataRegion', () => {
  it.each([
    ['eu', 'https://eu.openrouter.ai/api/v1'],
    ['us', 'https://us.openrouter.ai/api/v1'],
  ] as const)('sends %s OpenRouter requests to the regional base URL', (region, apiUrl) => {
    expect(withDataRegion(makeProvider('openrouter'), region).apiUrl).toBe(apiUrl);
  });

  it('pins Vercel AI Gateway inference to the region and keeps the gateway options', async () => {
    const vercel = makeProvider('vercel');
    const regional = withDataRegion(vercel, 'eu');
    const request = {
      kind: 'chat_completions',
      body: {
        model: 'anthropic/claude-sonnet-5',
        messages: [],
        providerOptions: { gateway: { only: ['anthropic'] } },
      },
    } as unknown as GatewayRequest;

    await regional.transformRequest(makeContext(regional, request));

    expect(vercel.transformRequest).toHaveBeenCalled();
    expect(regional.apiUrl).toBe(vercel.apiUrl);
    expect(request.body.providerOptions).toEqual({
      gateway: { only: ['anthropic'], inferenceRegion: { scope: 'zone', geoRegion: 'eu' } },
    });
  });

  it('leaves other providers unchanged', () => {
    const custom = makeProvider('custom');
    expect(withDataRegion(custom, 'eu')).toBe(custom);
  });
});
