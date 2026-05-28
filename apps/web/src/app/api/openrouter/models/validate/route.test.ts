import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import type { OpenRouterModel } from '@/lib/organizations/organization-types';
import { getEnhancedOpenRouterModels } from '@/lib/ai-gateway/providers/openrouter';
import { getUserFromAuth } from '@/lib/user/server';
import { getDirectByokModelsForUser } from '@/lib/ai-gateway/providers/direct-byok';
import { listAvailableExperimentModels } from '@/lib/ai-gateway/experiments/list-available-experiment-models';
import { ORGANIZATION_ID_HEADER } from '@/lib/constants';
import { POST } from './route';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/user/server', () => ({ getUserFromAuth: jest.fn() }));
jest.mock('@/lib/ai-gateway/providers/openrouter', () => ({
  getEnhancedOpenRouterModels: jest.fn(),
}));
jest.mock('@/lib/ai-gateway/providers/direct-byok', () => ({
  getDirectByokModelsForUser: jest.fn(),
}));
jest.mock('@/lib/ai-gateway/experiments/list-available-experiment-models', () => ({
  listAvailableExperimentModels: jest.fn(),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedGetEnhancedOpenRouterModels = jest.mocked(getEnhancedOpenRouterModels);
const mockedGetDirectByokModelsForUser = jest.mocked(getDirectByokModelsForUser);
const mockedListAvailableExperimentModels = jest.mocked(listAvailableExperimentModels);

function makeModel(id: string): OpenRouterModel {
  return {
    id,
    name: id,
    created: 0,
    description: '',
    architecture: {
      input_modalities: ['text'],
      output_modalities: ['text'],
      tokenizer: 'test',
    },
    top_provider: { is_moderated: false },
    pricing: { prompt: '0', completion: '0' },
    context_length: 0,
    supported_parameters: ['tools'],
  };
}

function request(modelId: string, headers?: HeadersInit) {
  return new NextRequest('http://localhost:3000/api/openrouter/models/validate', {
    method: 'POST',
    headers,
    body: JSON.stringify({ modelId }),
  });
}

describe('POST /api/openrouter/models/validate', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      organizationId: null,
      authFailedResponse: null,
    } as never);
    mockedGetEnhancedOpenRouterModels.mockResolvedValue({ data: [makeModel('available/model')] });
    mockedGetDirectByokModelsForUser.mockResolvedValue([]);
    mockedListAvailableExperimentModels.mockResolvedValue([]);
  });

  test('confirms a Kilo-eligible catalog model', async () => {
    const response = await POST(request('available/model'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ valid: true });
  });

  test('does not expose details for an unavailable model', async () => {
    const response = await POST(request('missing/model'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ valid: false, reason: 'unavailable' });
  });

  test('uses the public catalog after failed optional authentication', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      organizationId: null,
      authFailedResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    } as never);

    const response = await POST(request('available/model'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ valid: true });
  });

  test('rejects organization-scoped validation through the personal endpoint', async () => {
    const response = await POST(
      request('available/model', { [ORGANIZATION_ID_HEADER]: 'organization-id' })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Organization-scoped validation must use /api/organizations/[id]/models/validate',
    });
    expect(mockedGetUserFromAuth).not.toHaveBeenCalled();
    expect(mockedGetEnhancedOpenRouterModels).not.toHaveBeenCalled();
  });

  test('returns a service failure when catalog construction fails', async () => {
    mockedGetEnhancedOpenRouterModels.mockRejectedValue(new Error('catalog unavailable'));

    const response = await POST(request('available/model'));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Failed to validate model',
      message: 'Error from model catalog',
    });
  });

  test('loads authenticated auxiliary catalogs concurrently', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: 'user-id' },
      organizationId: null,
      authFailedResponse: null,
    } as never);
    mockedGetEnhancedOpenRouterModels.mockResolvedValue({ data: [] });
    let markByokStarted: (() => void) | undefined;
    const byokStarted = new Promise<void>(resolve => {
      markByokStarted = resolve;
    });
    type DirectByokModels = Awaited<ReturnType<typeof getDirectByokModelsForUser>>;
    let resolveByok: ((models: DirectByokModels) => void) | undefined;
    const byokPending = new Promise<DirectByokModels>(resolve => {
      resolveByok = resolve;
    });
    mockedGetDirectByokModelsForUser.mockImplementation(() => {
      if (!markByokStarted) throw new Error('BYOK start signal was not initialized');
      markByokStarted();
      return byokPending;
    });
    mockedListAvailableExperimentModels.mockResolvedValue([makeModel('experiment/model')]);

    const responsePromise = POST(request('experiment/model'));
    await byokStarted;
    const finishByok = resolveByok;
    if (!finishByok) throw new Error('BYOK lookup did not start');
    try {
      expect(mockedListAvailableExperimentModels).toHaveBeenCalledTimes(1);
    } finally {
      finishByok([]);
      await responsePromise;
    }
  });

  test('rejects an invalid body without reading a catalog', async () => {
    const response = await POST(
      new NextRequest('http://localhost:3000/api/openrouter/models/validate', {
        method: 'POST',
        body: JSON.stringify({ modelId: '' }),
      })
    );

    expect(response.status).toBe(400);
    expect(mockedGetEnhancedOpenRouterModels).not.toHaveBeenCalled();
  });
});
