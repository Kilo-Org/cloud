import { beforeEach, describe, expect, it } from '@jest/globals';
import type { GatewayModelMap } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-model-metadata';
import {
  getOpenRouterModelsFromDatabase,
  getVercelModelsFromDatabase,
  getVercelModelsMetadataFromDatabase,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { getRuntimeGatewayRoutingConfig } from '@kilocode/web-shared/lib/ai-gateway/providers/routing-config';
import { getVercelModelIdOverrides } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import { getModelGatewayAvailability } from '@kilocode/web-shared/lib/ai-gateway/providers/model-gateway-availability';
import type * as GatewayModelsCacheModule from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import type * as MapModelIdToVercelModule from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  ...jest.requireActual<typeof GatewayModelsCacheModule>(
    '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache'
  ),
  getOpenRouterModelsFromDatabase: jest.fn(),
  getVercelModelsFromDatabase: jest.fn(),
  getVercelModelsMetadataFromDatabase: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/routing-config', () => ({
  getRuntimeGatewayRoutingConfig: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel', () => ({
  ...jest.requireActual<typeof MapModelIdToVercelModule>(
    '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel'
  ),
  getVercelModelIdOverrides: jest.fn(),
}));

function vercelModel(id: string, regions?: string[]): GatewayModelMap[string] {
  return { id, name: id, type: 'language', regions, endpoints: [] };
}

describe('getModelGatewayAvailability', () => {
  beforeEach(() => {
    jest.mocked(getVercelModelIdOverrides).mockResolvedValue(new Map());
    jest
      .mocked(getRuntimeGatewayRoutingConfig)
      .mockResolvedValue({ vercelOptOutModels: new Set() });
    jest
      .mocked(getOpenRouterModelsFromDatabase)
      .mockResolvedValue(new Set(['anthropic/claude-opus-5', 'qwen/qwen3-max']));
    jest
      .mocked(getVercelModelsFromDatabase)
      .mockResolvedValue(new Set(['anthropic/claude-opus-5', 'alibaba/qwen3-max']));
    jest.mocked(getVercelModelsMetadataFromDatabase).mockResolvedValue({
      'anthropic/claude-opus-5': vercelModel('anthropic/claude-opus-5', ['us', 'eu', 'xx', 'jp']),
      'alibaba/qwen3-max': vercelModel('alibaba/qwen3-max'),
    });
  });

  it('reports both gateways and the known Vercel regions in a fixed order', async () => {
    await expect(getModelGatewayAvailability('anthropic/claude-opus-5')).resolves.toEqual({
      vercel: { available: true, regions: ['us', 'eu', 'jp'] },
      openrouter: { available: true },
    });
  });

  it('maps the model ID to Vercel and reports no regions when Vercel lists none', async () => {
    await expect(getModelGatewayAvailability('qwen/qwen3-max')).resolves.toEqual({
      vercel: { available: true, regions: [] },
      openrouter: { available: true },
    });
  });

  it('reports Vercel as unavailable for a model opted out of Vercel routing', async () => {
    jest
      .mocked(getRuntimeGatewayRoutingConfig)
      .mockResolvedValue({ vercelOptOutModels: new Set(['anthropic/claude-opus-5']) });

    await expect(getModelGatewayAvailability('anthropic/claude-opus-5')).resolves.toEqual({
      vercel: { available: false, regions: [] },
      openrouter: { available: true },
    });
  });

  it('reports a model neither gateway lists as unavailable', async () => {
    await expect(getModelGatewayAvailability('acme/unknown')).resolves.toEqual({
      vercel: { available: false, regions: [] },
      openrouter: { available: false },
    });
  });
});
