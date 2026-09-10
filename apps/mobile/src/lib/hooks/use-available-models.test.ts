import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchModels,
  fetchOrgDefaults,
  OpenRouterModelsResponseSchema,
  OrganizationDefaultsResponseSchema,
  toModelOptions,
} from './use-available-models';

// Stub native/expo modules so pure-node Vitest can resolve the
// module graph when importing from use-available-models.ts.
vi.mock('expo-secure-store', () => ({}));
vi.mock('@tanstack/react-query', () => ({}));
vi.mock('@/lib/config', () => ({ API_BASE_URL: 'https://api.example.com' }));
vi.mock('@/lib/storage-keys', () => ({ AUTH_TOKEN_KEY: 'mock-token' }));
const getAuthTokenForRequest = vi.hoisted(() => vi.fn());
const getGatewayAuthTokenForRequest = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/token-owner', () => ({
  getAuthTokenForRequest,
}));
vi.mock('@/lib/auth/credentials', () => ({ getGatewayAuthTokenForRequest }));

beforeEach(() => {
  getAuthTokenForRequest.mockReset().mockResolvedValue('api-token');
  getGatewayAuthTokenForRequest.mockReset().mockResolvedValue('gateway-token');
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('toModelOptions', () => {
  it('passes pricing through to the ModelOption', () => {
    const pricing = { prompt: '0.00000175', completion: '0.000014' };
    const result = toModelOptions({
      data: [
        {
          id: 'priced/model',
          name: 'Display: Priced Model',
          pricing,
          preferredIndex: 0,
          opencode: { variants: { high: {} } },
        },
      ],
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.pricing).toEqual(pricing);
    expect(result[0]?.id).toBe('priced/model');
    expect(result[0]?.name).toBe('Priced Model');
  });

  it('returns empty array for undefined data', () => {
    expect(toModelOptions(undefined)).toEqual([]);
  });
});

describe('OpenRouterModelsResponseSchema', () => {
  it('parses a valid body with a data array', () => {
    const body = {
      data: [
        {
          id: 'priced/model',
          name: 'Display: Priced Model',
          pricing: { prompt: '0.00000175', completion: '0.000014' },
          preferredIndex: 0,
          opencode: { variants: { high: {} } },
        },
      ],
    };
    expect(OpenRouterModelsResponseSchema.parse(body)).toEqual(body);
  });

  it('rejects a body missing the data field', () => {
    expect(() => OpenRouterModelsResponseSchema.parse({})).toThrow();
  });

  it('rejects a data array entry missing the id field', () => {
    expect(() => OpenRouterModelsResponseSchema.parse({ data: [{ name: 'Noid' }] })).toThrow();
  });

  it('ignores extra fields on a data entry', () => {
    const parsed = OpenRouterModelsResponseSchema.parse({
      data: [{ id: 'a', name: 'A', someUnknown: true }],
    });
    expect(parsed.data[0]).toEqual({ id: 'a', name: 'A' });
  });
});

describe('OrganizationDefaultsResponseSchema', () => {
  it('parses a valid defaultModel body', () => {
    expect(OrganizationDefaultsResponseSchema.parse({ defaultModel: 'priced/model' })).toEqual({
      defaultModel: 'priced/model',
    });
  });

  it('rejects a body missing defaultModel', () => {
    expect(() => OrganizationDefaultsResponseSchema.parse({})).toThrow();
  });

  it('ignores extra fields', () => {
    expect(OrganizationDefaultsResponseSchema.parse({ defaultModel: 'm', extra: true })).toEqual({
      defaultModel: 'm',
    });
  });
});

describe('model request credentials', () => {
  it('uses the refresh-capable gateway credential for personal models', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ data: [] }));

    await fetchModels(undefined);

    expect(getGatewayAuthTokenForRequest).toHaveBeenCalledOnce();
    expect(getAuthTokenForRequest).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      'https://api.example.com/api/openrouter/models',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer gateway-token' }),
      })
    );
  });

  it('uses the API credential for organization models and defaults', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ data: [] }))
      .mockResolvedValueOnce(Response.json({ defaultModel: 'model' }));

    await fetchModels('org-1');
    await fetchOrgDefaults('org-1');

    expect(getAuthTokenForRequest).toHaveBeenNthCalledWith(1, 'api');
    expect(getAuthTokenForRequest).toHaveBeenNthCalledWith(2, 'api');
    expect(getGatewayAuthTokenForRequest).not.toHaveBeenCalled();
  });
});
