import { beforeEach, describe, expect, test } from '@jest/globals';
import { TRPCError } from '@trpc/server';
import type { AutoRoutingSettingsResponse } from '@kilocode/auto-routing-contracts';
import { NextRequest } from 'next/server';
import {
  getAutoRoutingSettings,
  updateAutoRoutingSettings,
} from '@/lib/ai-gateway/auto-routing-admin-client';
import { poolValidationMessage } from '@/lib/ai-gateway/auto-routing-pool-validation';
import { requireActiveSubscriptionOrTrial } from '@/lib/organizations/trial-middleware';
import { getUserFromAuth } from '@/lib/user/server';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { GET, PUT } from './route';

jest.mock('@/lib/ai-gateway/auto-routing-admin-client');
jest.mock('@/lib/organizations/trial-middleware');
jest.mock('@/lib/user/server');
jest.mock('@/routers/organizations/utils');
jest.mock('@/lib/ai-gateway/providers/openrouter', () => ({
  getEnhancedOpenRouterModels: jest.fn(),
}));
jest.mock('@/lib/ai-gateway/experiments/list-available-experiment-models', () => ({
  listAvailableExperimentModels: jest.fn(),
}));
jest.mock('@/lib/ai-gateway/providers/direct-byok', () => ({
  getDirectByokModelsForUser: jest.fn(),
  getDirectByokModelsForOrganization: jest.fn(),
}));
jest.mock('@/lib/organizations/organization-models', () => ({
  getAvailableModelsForOrganization: jest.fn(),
}));
jest.mock('@/lib/ai-gateway/models', () => ({
  kiloExclusiveModels: [
    { public_id: 'kilo/hidden-model', status: 'hidden' },
    { public_id: 'kilo/public-model', status: 'public' },
  ],
}));

const { getEnhancedOpenRouterModels } = jest.requireMock('@/lib/ai-gateway/providers/openrouter');
const { listAvailableExperimentModels } = jest.requireMock(
  '@/lib/ai-gateway/experiments/list-available-experiment-models'
);
const { getDirectByokModelsForUser, getDirectByokModelsForOrganization } = jest.requireMock(
  '@/lib/ai-gateway/providers/direct-byok'
);
const { getAvailableModelsForOrganization } = jest.requireMock(
  '@/lib/organizations/organization-models'
);

const mockedGetAutoRoutingSettings = jest.mocked(getAutoRoutingSettings);
const mockedUpdateAutoRoutingSettings = jest.mocked(updateAutoRoutingSettings);
const mockedRequireActiveSubscriptionOrTrial = jest.mocked(requireActiveSubscriptionOrTrial);
const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedEnsureOrganizationAccess = jest.mocked(ensureOrganizationAccess);
const mockedGetEnhanced = jest.mocked(getEnhancedOpenRouterModels);
const mockedListExperiments = jest.mocked(listAvailableExperimentModels);
const mockedGetByokUser = jest.mocked(getDirectByokModelsForUser);
const mockedGetByokOrg = jest.mocked(getDirectByokModelsForOrganization);
const mockedGetOrgModels = jest.mocked(getAvailableModelsForOrganization);

const USER_ID = 'user-1';
const ORGANIZATION_ID = 'org-1';

function model(id: string, variants?: Record<string, Record<string, unknown>>) {
  return {
    id,
    name: id,
    created: 0,
    description: id,
    architecture: {
      input_modalities: ['text'],
      output_modalities: ['text'],
      tokenizer: 'Other',
    },
    top_provider: { is_moderated: false, context_length: 100_000 },
    pricing: { prompt: '0', completion: '0' },
    context_length: 100_000,
    ...(variants ? { opencode: { variants } } : {}),
  };
}

function makeRequest(path: string, body?: unknown) {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: body === undefined ? 'GET' : 'PUT',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function settingsBody(
  overrides: Partial<AutoRoutingSettingsResponse> = {}
): AutoRoutingSettingsResponse {
  return {
    ownerType: 'user',
    ownerId: USER_ID,
    mode: 'cost_per_accuracy',
    configuredMode: null,
    defaultMode: 'cost_per_accuracy',
    configuredPool: null,
    poolStatuses: [],
    ...overrides,
  };
}

describe('/api/auto-routing/settings', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: USER_ID, is_admin: false },
      authFailedResponse: null,
    } as never);
    mockedListExperiments.mockResolvedValue([]);
    mockedGetByokUser.mockResolvedValue([]);
    mockedGetByokOrg.mockResolvedValue([]);
    mockedGetEnhanced.mockResolvedValue({
      data: [
        model('anthropic/claude-sonnet-4', { high: {}, low: {} }),
        model('google/gemini-2.5-flash'),
        model('kilo/public-model'),
      ],
    });
  });

  test('returns 401 when unauthenticated', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: new Response(),
    } as never);

    const response = await GET(makeRequest('/api/auto-routing/settings'));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Authentication required' });
  });

  test('GET annotates departed pool entries as unavailable without dropping them', async () => {
    mockedGetAutoRoutingSettings.mockResolvedValue({
      status: 200,
      body: settingsBody({
        configuredPool: [
          { model: 'anthropic/claude-sonnet-4', variant: 'high' },
          { model: 'removed/model', variant: null },
        ],
        poolStatuses: [
          {
            entry: { model: 'anthropic/claude-sonnet-4', variant: 'high' },
            status: 'ready',
          },
          {
            entry: { model: 'removed/model', variant: null },
            status: 'ready',
          },
        ],
      }),
    });

    const response = await GET(makeRequest('/api/auto-routing/settings'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        configuredPool: [
          { model: 'anthropic/claude-sonnet-4', variant: 'high', unavailable: false },
          { model: 'removed/model', variant: null, unavailable: true },
        ],
      })
    );
  });

  test('rejects org member PUT without owner/billing_manager role with 401', async () => {
    // Production ensureOrganizationAccess throws UNAUTHORIZED for insufficient
    // role (same as missing membership); trpcErrorResponse maps that to 401.
    mockedEnsureOrganizationAccess.mockRejectedValue(
      new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'You do not have permission to manage this organization',
      })
    );

    const response = await PUT(
      makeRequest(`/api/auto-routing/settings?organizationId=${ORGANIZATION_ID}`, {
        mode: null,
        pool: null,
      })
    );

    expect(response.status).toBe(401);
    expect(mockedUpdateAutoRoutingSettings).not.toHaveBeenCalled();
    expect(mockedEnsureOrganizationAccess).toHaveBeenCalledWith(
      expect.anything(),
      ORGANIZATION_ID,
      ['owner', 'billing_manager']
    );
  });

  test('allows billing_manager organization PUT when entitled', async () => {
    mockedEnsureOrganizationAccess.mockResolvedValue(undefined as never);
    mockedRequireActiveSubscriptionOrTrial.mockResolvedValue(undefined as never);
    mockedGetOrgModels.mockResolvedValue({
      data: [model('google/gemini-2.5-flash')],
    });
    mockedUpdateAutoRoutingSettings.mockResolvedValue({
      status: 200,
      body: settingsBody({
        ownerType: 'org',
        ownerId: ORGANIZATION_ID,
        configuredMode: null,
        configuredPool: [{ model: 'google/gemini-2.5-flash', variant: null }],
        poolStatuses: [
          {
            entry: { model: 'google/gemini-2.5-flash', variant: null },
            status: 'pending',
          },
        ],
      }),
    });

    const response = await PUT(
      makeRequest(`/api/auto-routing/settings?organizationId=${ORGANIZATION_ID}`, {
        mode: null,
        pool: [{ model: 'google/gemini-2.5-flash', variant: null }],
      })
    );

    expect(response.status).toBe(200);
    expect(mockedUpdateAutoRoutingSettings).toHaveBeenCalledWith({
      ownerType: 'org',
      ownerId: ORGANIZATION_ID,
      mode: null,
      pool: [{ model: 'google/gemini-2.5-flash', variant: null }],
    });
  });

  test('blocks organization PUT without active subscription or trial', async () => {
    mockedEnsureOrganizationAccess.mockResolvedValue(undefined as never);
    mockedRequireActiveSubscriptionOrTrial.mockRejectedValue(
      new TRPCError({
        code: 'NOT_FOUND',
        message: 'Organization subscription not found',
      })
    );

    const response = await PUT(
      makeRequest(`/api/auto-routing/settings?organizationId=${ORGANIZATION_ID}`, {
        mode: null,
        pool: null,
      })
    );

    expect(response.status).toBe(404);
    expect(mockedUpdateAutoRoutingSettings).not.toHaveBeenCalled();
  });

  test('allows personal PUT for the authenticated user', async () => {
    mockedUpdateAutoRoutingSettings.mockResolvedValue({
      status: 200,
      body: settingsBody({
        configuredMode: 'best_accuracy',
        mode: 'best_accuracy',
        configuredPool: [{ model: 'google/gemini-2.5-flash', variant: null }],
        poolStatuses: [
          {
            entry: { model: 'google/gemini-2.5-flash', variant: null },
            status: 'pending',
          },
        ],
      }),
    });

    const response = await PUT(
      makeRequest('/api/auto-routing/settings', {
        mode: 'best_accuracy',
        pool: [{ model: 'google/gemini-2.5-flash', variant: null }],
      })
    );

    expect(response.status).toBe(200);
    expect(mockedUpdateAutoRoutingSettings).toHaveBeenCalledWith({
      ownerType: 'user',
      ownerId: USER_ID,
      mode: 'best_accuracy',
      pool: [{ model: 'google/gemini-2.5-flash', variant: null }],
    });
    expect(mockedRequireActiveSubscriptionOrTrial).not.toHaveBeenCalled();
  });

  test('returns 400 for invalid body', async () => {
    const response = await PUT(
      makeRequest('/api/auto-routing/settings', {
        mode: 'not-a-mode',
        pool: null,
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid routing settings' });
    expect(mockedUpdateAutoRoutingSettings).not.toHaveBeenCalled();
  });

  test('maps worker 429 quota errors including retryAt', async () => {
    const retryAt = '2026-07-29T12:00:00.000Z';
    mockedUpdateAutoRoutingSettings.mockResolvedValue({
      status: 429,
      body: {
        error: 'Benchmark profile request limit exceeded',
        retryAt,
      },
    });

    const response = await PUT(
      makeRequest('/api/auto-routing/settings', {
        mode: null,
        pool: [{ model: 'google/gemini-2.5-flash', variant: null }],
      })
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: 'Benchmark profile request limit exceeded',
      retryAt,
    });
  });

  test.each([
    {
      name: 'virtual model',
      entry: { model: 'kilo-auto/efficient', variant: null },
      reason: 'virtual_model' as const,
      setup: () => {
        mockedGetEnhanced.mockResolvedValue({
          data: [model('kilo-auto/efficient')],
        });
      },
    },
    {
      name: 'experiment model',
      entry: { model: 'experiment/active', variant: null },
      reason: 'experiment_model' as const,
      setup: () => {
        mockedListExperiments.mockResolvedValue([model('experiment/active')]);
      },
    },
    {
      name: 'hidden model',
      entry: { model: 'kilo/hidden-model', variant: null },
      reason: 'hidden_model' as const,
      setup: () => {
        mockedGetEnhanced.mockResolvedValue({
          data: [model('kilo/hidden-model')],
        });
      },
    },
    {
      name: 'BYOK-only model',
      entry: { model: 'openai-codex/gpt-5', variant: null },
      reason: 'byok_only_model' as const,
      setup: () => {
        mockedGetByokUser.mockResolvedValue([model('openai-codex/gpt-5')]);
      },
    },
  ])('rejects $name with a specific 400 message', async ({ entry, reason, setup }) => {
    setup();

    const response = await PUT(
      makeRequest('/api/auto-routing/settings', {
        mode: null,
        pool: [entry],
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        error: poolValidationMessage(reason),
        reason,
      })
    );
    expect(mockedUpdateAutoRoutingSettings).not.toHaveBeenCalled();
  });

  test('rejects organization-denied models with a specific 400 message', async () => {
    mockedEnsureOrganizationAccess.mockResolvedValue(undefined as never);
    mockedRequireActiveSubscriptionOrTrial.mockResolvedValue(undefined as never);
    mockedGetEnhanced.mockResolvedValue({
      data: [model('openai/gpt-4o'), model('google/gemini-2.5-flash')],
    });
    mockedGetOrgModels.mockResolvedValue({
      data: [model('google/gemini-2.5-flash')],
    });

    const response = await PUT(
      makeRequest(`/api/auto-routing/settings?organizationId=${ORGANIZATION_ID}`, {
        mode: null,
        pool: [{ model: 'openai/gpt-4o', variant: null }],
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        error: poolValidationMessage('organization_denied_model'),
        reason: 'organization_denied_model',
      })
    );
  });

  test('rejects missing variant when model exposes variants', async () => {
    const response = await PUT(
      makeRequest('/api/auto-routing/settings', {
        mode: null,
        pool: [{ model: 'anthropic/claude-sonnet-4', variant: null }],
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        reason: 'missing_variant',
        error: poolValidationMessage('missing_variant'),
      })
    );
  });

  test('rejects unknown variant keys', async () => {
    const response = await PUT(
      makeRequest('/api/auto-routing/settings', {
        mode: null,
        pool: [{ model: 'anthropic/claude-sonnet-4', variant: 'max' }],
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        reason: 'unknown_variant',
      })
    );
  });

  test('rejects unexpected variant on models without variants', async () => {
    const response = await PUT(
      makeRequest('/api/auto-routing/settings', {
        mode: null,
        pool: [{ model: 'google/gemini-2.5-flash', variant: 'high' }],
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        reason: 'unexpected_variant',
      })
    );
  });

  test('rejects more than 10 entries', async () => {
    const pool = Array.from({ length: 11 }, (_, i) => ({
      model: `provider/model-${i}`,
      variant: null,
    }));

    const response = await PUT(
      makeRequest('/api/auto-routing/settings', {
        mode: null,
        pool,
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        reason: 'too_many_entries',
        error: poolValidationMessage('too_many_entries'),
      })
    );
  });

  test('rejects duplicate exact pairs but allows same model with different variants', async () => {
    const duplicate = await PUT(
      makeRequest('/api/auto-routing/settings', {
        mode: null,
        pool: [
          { model: 'anthropic/claude-sonnet-4', variant: 'high' },
          { model: 'anthropic/claude-sonnet-4', variant: 'high' },
        ],
      })
    );
    expect(duplicate.status).toBe(400);
    await expect(duplicate.json()).resolves.toEqual(
      expect.objectContaining({ reason: 'duplicate_pair' })
    );

    mockedUpdateAutoRoutingSettings.mockResolvedValue({
      status: 200,
      body: settingsBody({
        configuredPool: [
          { model: 'anthropic/claude-sonnet-4', variant: 'high' },
          { model: 'anthropic/claude-sonnet-4', variant: 'low' },
        ],
        poolStatuses: [],
      }),
    });

    const allowed = await PUT(
      makeRequest('/api/auto-routing/settings', {
        mode: null,
        pool: [
          { model: 'anthropic/claude-sonnet-4', variant: 'high' },
          { model: 'anthropic/claude-sonnet-4', variant: 'low' },
        ],
      })
    );
    expect(allowed.status).toBe(200);
    expect(mockedUpdateAutoRoutingSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        pool: [
          { model: 'anthropic/claude-sonnet-4', variant: 'high' },
          { model: 'anthropic/claude-sonnet-4', variant: 'low' },
        ],
      })
    );
  });

  test('forwards retryEntries to the worker when present', async () => {
    mockedUpdateAutoRoutingSettings.mockResolvedValue({
      status: 200,
      body: settingsBody({
        configuredPool: [{ model: 'google/gemini-2.5-flash', variant: null }],
        poolStatuses: [
          {
            entry: { model: 'google/gemini-2.5-flash', variant: null },
            status: 'pending',
          },
        ],
      }),
    });

    const response = await PUT(
      makeRequest('/api/auto-routing/settings', {
        mode: null,
        pool: [{ model: 'google/gemini-2.5-flash', variant: null }],
        retryEntries: [{ model: 'google/gemini-2.5-flash', variant: null }],
      })
    );

    expect(response.status).toBe(200);
    expect(mockedUpdateAutoRoutingSettings).toHaveBeenCalledWith({
      ownerType: 'user',
      ownerId: USER_ID,
      mode: null,
      pool: [{ model: 'google/gemini-2.5-flash', variant: null }],
      retryEntries: [{ model: 'google/gemini-2.5-flash', variant: null }],
    });
  });

  test('rejects retryEntries when pool is null before calling the worker', async () => {
    const response = await PUT(
      makeRequest('/api/auto-routing/settings', {
        mode: null,
        pool: null,
        retryEntries: [{ model: 'google/gemini-2.5-flash', variant: null }],
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        reason: 'invalid_retry_entries',
        error: 'retryEntries require a non-null pool',
      })
    );
    expect(mockedUpdateAutoRoutingSettings).not.toHaveBeenCalled();
  });

  test('rejects retryEntries that are not in pool before calling the worker', async () => {
    const response = await PUT(
      makeRequest('/api/auto-routing/settings', {
        mode: null,
        pool: [{ model: 'google/gemini-2.5-flash', variant: null }],
        retryEntries: [{ model: 'anthropic/claude-sonnet-4', variant: 'high' }],
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        reason: 'invalid_retry_entries',
        error: expect.stringContaining('retryEntry must appear in pool'),
      })
    );
    expect(mockedUpdateAutoRoutingSettings).not.toHaveBeenCalled();
  });
});
