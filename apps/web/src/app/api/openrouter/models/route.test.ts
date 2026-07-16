import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import type { OpenRouterModel } from '@/lib/organizations/organization-types';
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
jest.mock('@/lib/ai-gateway/auto-routing-table-cache', () => ({
  getCachedRoutingTable: jest.fn(),
}));
jest.mock('@/lib/ai-gateway/auto-model/resolution', () => ({
  getAutoFreeCandidates: jest.fn(),
}));
jest.mock('@/lib/drizzle', () => ({ readDb: {} }));

const { getUserFromAuth } = jest.requireMock('@/lib/user/server');
const { getEnhancedOpenRouterModels } = jest.requireMock('@/lib/ai-gateway/providers/openrouter');
const { getDirectByokModelsForUser } = jest.requireMock('@/lib/ai-gateway/providers/direct-byok');
const { listAvailableExperimentModels } = jest.requireMock(
  '@/lib/ai-gateway/experiments/list-available-experiment-models'
);
const { addUserByokAvailability, getUserByokProviderIds } =
  jest.requireMock('@/lib/ai-gateway/byok');
const { getAvailableModelsForOrganization } = jest.requireMock(
  '@/lib/organizations/organization-models'
);
const { getCachedRoutingTable } = jest.requireMock('@/lib/ai-gateway/auto-routing-table-cache');
const { getAutoFreeCandidates } = jest.requireMock('@/lib/ai-gateway/auto-model/resolution');

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedGetEnhancedOpenRouterModels = jest.mocked(getEnhancedOpenRouterModels);
const mockedGetDirectByokModelsForUser = jest.mocked(getDirectByokModelsForUser);
const mockedListAvailableExperimentModels = jest.mocked(listAvailableExperimentModels);
const mockedAddUserByokAvailability = jest.mocked(addUserByokAvailability);
const mockedGetUserByokProviderIds = jest.mocked(getUserByokProviderIds);
const mockedGetAvailableModelsForOrganization = jest.mocked(getAvailableModelsForOrganization);
const mockedGetCachedRoutingTable = jest.mocked(getCachedRoutingTable);
const mockedGetAutoFreeCandidates = jest.mocked(getAutoFreeCandidates);

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

function request(headers?: Record<string, string>) {
  return new NextRequest('http://localhost:3000/api/openrouter/models', { headers });
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
    mockedGetCachedRoutingTable.mockResolvedValue(null);
    mockedGetAutoFreeCandidates.mockResolvedValue([]);
  });

  test('leaves BYOK availability undefined for unauthenticated requests', async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: [makeModel('public/model')] });
    expect(mockedGetUserByokProviderIds).not.toHaveBeenCalled();
    expect(mockedAddUserByokAvailability).not.toHaveBeenCalled();
    expect(mockedGetCachedRoutingTable).not.toHaveBeenCalled();
    expect(mockedGetAutoFreeCandidates).not.toHaveBeenCalled();
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

  test('adds auto-routing models from routing sources', async () => {
    const efficientModel = makeModel('kilo-auto/efficient');
    const freeModel = makeModel('kilo-auto/free');
    const balancedModel = makeModel('kilo-auto/balanced');
    const geminiModel = makeModel('google/gemini-2.5-flash');
    const gptMiniModel = makeModel('openai/gpt-5.4-mini');
    const poolsideModel = makeModel('poolside/laguna-m.1:free');
    mockedGetEnhancedOpenRouterModels.mockResolvedValue({
      data: [efficientModel, freeModel, balancedModel, geminiModel, gptMiniModel, poolsideModel],
    });
    mockedGetAutoFreeCandidates.mockResolvedValue([
      'poolside/laguna-m.1:free',
      'missing/free-model',
    ]);
    mockedGetCachedRoutingTable.mockResolvedValue({
      routes: {
        'implementation/code_generation': [
          { model: 'google/gemini-2.5-flash' },
          { model: 'openai/gpt-5.4-mini' },
        ],
        'analysis/debugging': [
          { model: 'kilo-auto/balanced' },
          { model: 'google/gemini-2.5-flash' },
        ],
      },
    } as never);

    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: [
        {
          ...efficientModel,
          autoRouting: {
            models: ['google/gemini-2.5-flash', 'openai/gpt-5.4-mini'],
          },
        },
        {
          ...freeModel,
          autoRouting: {
            models: ['poolside/laguna-m.1:free'],
          },
        },
        balancedModel,
        geminiModel,
        gptMiniModel,
        poolsideModel,
      ],
    });
  });

  test('adds auto-routing to organization models', async () => {
    const efficientModel = makeModel('kilo-auto/efficient');
    const allowedModel = makeModel('openai/gpt-5.4-mini');
    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: 'user-id' },
      organizationId: 'org-1',
      authFailedResponse: null,
    } as never);
    mockedGetAvailableModelsForOrganization.mockResolvedValue({
      data: [efficientModel, allowedModel],
    } as never);
    mockedGetCachedRoutingTable.mockResolvedValue({
      routes: {
        'implementation/code_generation': [{ model: allowedModel.id }],
      },
    } as never);

    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: [
        {
          ...efficientModel,
          autoRouting: {
            models: [allowedModel.id],
          },
        },
        allowedModel,
      ],
    });
  });
});
