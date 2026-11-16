import { beforeEach, describe, expect, it } from '@jest/globals';
import {
  getOpenRouterModelsFromDatabase,
  getVercelModelsFromDatabase,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { getVercelModelIdOverrides } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import { getModelGateways } from '@kilocode/web-shared/lib/ai-gateway/providers/model-gateway-availability';
import type * as GatewayModelsCacheModule from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import type * as MapModelIdToVercelModule from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  ...jest.requireActual<typeof GatewayModelsCacheModule>(
    '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache'
  ),
  getOpenRouterModelsFromDatabase: jest.fn(),
  getVercelModelsFromDatabase: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel', () => ({
  ...jest.requireActual<typeof MapModelIdToVercelModule>(
    '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel'
  ),
  getVercelModelIdOverrides: jest.fn(),
}));

describe('getModelGateways', () => {
  beforeEach(() => {
    jest.mocked(getVercelModelIdOverrides).mockResolvedValue(new Map());
    jest
      .mocked(getOpenRouterModelsFromDatabase)
      .mockResolvedValue(new Set(['anthropic/claude-opus-5', 'qwen/qwen3-max', 'acme/or-only']));
    jest
      .mocked(getVercelModelsFromDatabase)
      .mockResolvedValue(new Set(['anthropic/claude-opus-5', 'alibaba/qwen3-max']));
  });

  it('lists both gateways when both serve the model', async () => {
    await expect(getModelGateways('anthropic/claude-opus-5')).resolves.toEqual([
      'vercel',
      'openrouter',
    ]);
  });

  it('maps the model ID to Vercel', async () => {
    await expect(getModelGateways('qwen/qwen3-max')).resolves.toEqual(['vercel', 'openrouter']);
  });

  it('lists only the gateways that serve the model', async () => {
    await expect(getModelGateways('acme/or-only')).resolves.toEqual(['openrouter']);
    await expect(getModelGateways('acme/unknown')).resolves.toEqual([]);
  });
});
