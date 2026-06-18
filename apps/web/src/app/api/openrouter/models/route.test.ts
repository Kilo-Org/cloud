import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import type { OpenRouterModel } from '@/lib/organizations/organization-types';
import { getEnhancedOpenRouterModels } from '@/lib/ai-gateway/providers/openrouter';
import { getUserFromAuth } from '@/lib/user/server';
import { getDirectByokModelsForUser } from '@/lib/ai-gateway/providers/direct-byok';
import { listAvailableExperimentModels } from '@/lib/ai-gateway/experiments/list-available-experiment-models';
import { addUserByokAvailability, getUserByokProviderIds } from '@/lib/ai-gateway/byok';
import { getAvailableModelsForOrganization } from '@/lib/organizations/organization-models';
import { GET } from './route';

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
jest.mock('@/lib/ai-gateway/byok', () => ({
  addUserByokAvailability: jest.fn(),
  getUserByokProviderIds: jest.fn(),
}));
jest.mock('@/lib/organizations/organization-models', () => ({
  getAvailableModelsForOrganization: jest.fn(),
}));
jest.mock('@/lib/drizzle', () => ({ readDb: {} }));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedGetEnhancedOpenRouterModels = jest.mocked(getEnhancedOpenRouterModels);
const mockedGetDirectByokModelsForUser = jest.mocked(getDirectByokModelsForUser);
const mockedListAvailableExperimentModels = jest.mocked(listAvailableExperimentModels);
const mockedAddUserByokAvailability = jest.mocked(addUserByokAvailability);
const mockedGetUserByokProviderIds = jest.mocked(getUserByokProviderIds);
const mockedGetAvailableModelsForOrganization = jest.mocked(getAvailableModelsForOrganization);

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
  };
}

function request() {
  return new NextRequest('http://localhost:3000/api/openrouter/models');
}

describe('GET /api/openrouter/models', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      organizationId: null,
      authFailedResponse: null,
    } as never);
    mockedGetEnhancedOpenRouterModels.mockResolvedValue({ data: [makeModel('public/model')] });
    mockedGetDirectByokModelsForUser.mockResolvedValue([]);
    mockedListAvailableExperimentModels.mockResolvedValue([]);
    mockedGetUserByokProviderIds.mockResolvedValue([]);
    mockedGetAvailableModelsForOrganization.mockResolvedValue(null);
  });

  test('leaves BYOK availability undefined for unauthenticated requests', async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: [makeModel('public/model')] });
    expect(mockedGetUserByokProviderIds).not.toHaveBeenCalled();
    expect(mockedAddUserByokAvailability).not.toHaveBeenCalled();
  });

  test('returns BYOK availability for regular and direct authenticated models', async () => {
    const publicModel = makeModel('public/model');
    const directModel = { ...makeModel('direct/model'), hasUserByokAvailable: true };
    const experimentModel = makeModel('experiment/model');
    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: 'user-id' },
      organizationId: null,
      authFailedResponse: null,
    } as never);
    mockedGetDirectByokModelsForUser.mockResolvedValue([directModel] as never);
    mockedListAvailableExperimentModels.mockResolvedValue([experimentModel]);
    mockedGetUserByokProviderIds.mockResolvedValue(['anthropic']);
    mockedAddUserByokAvailability.mockResolvedValue([
      { ...publicModel, hasUserByokAvailable: true },
    ]);

    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: [{ ...publicModel, hasUserByokAvailable: true }, directModel, experimentModel],
    });
  });
});
