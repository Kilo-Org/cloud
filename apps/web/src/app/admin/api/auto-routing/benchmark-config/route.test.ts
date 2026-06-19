import { NextRequest } from 'next/server';
import type { User } from '@kilocode/db';
import {
  getBenchmarkConfig,
  updateBenchmarkConfig,
} from '@/lib/ai-gateway/auto-routing-benchmark-admin-client';
import { getUserFromAuth } from '@/lib/user/server';
import { findExperimentReservedModelIds } from '@/lib/ai-gateway/experiments/reserved-ids';
import type { KiloExclusiveModel } from '@/lib/ai-gateway/providers/kilo-exclusive-model';
import type * as ModelsModule from '@/lib/ai-gateway/models';

jest.mock('@/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
}));

jest.mock('@/lib/ai-gateway/auto-routing-benchmark-admin-client', () => ({
  getBenchmarkConfig: jest.fn(),
  updateBenchmarkConfig: jest.fn(),
}));

jest.mock('@/lib/ai-gateway/experiments/reserved-ids', () => ({
  findExperimentReservedModelIds: jest.fn(),
}));

// Stub the catalog so tests don't depend on any specific provider file.
// 'test-exclusive/alibaba-only' maps to the alibaba gateway (chat_completions only).
jest.mock('@/lib/ai-gateway/models', () => {
  const actual = jest.requireActual<typeof ModelsModule>('@/lib/ai-gateway/models');
  const stubModel: KiloExclusiveModel = {
    public_id: 'test-exclusive/alibaba-only',
    display_name: 'Test Alibaba-only',
    description: 'stub for unit tests',
    context_length: 8192,
    max_completion_tokens: 4096,
    status: 'public',
    flags: [],
    gateway: 'alibaba',
    internal_id: 'stub-internal',
    pricing: null,
    exclusive_to: [],
    inference_provider_restriction: [],
  };
  return {
    ...actual,
    findKiloExclusiveModel: (id: string) =>
      id === 'test-exclusive/alibaba-only' ? stubModel : actual.findKiloExclusiveModel(id),
  };
});

import { PUT } from './route';

const mockGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockGetBenchmarkConfig = jest.mocked(getBenchmarkConfig);
const mockUpdateBenchmarkConfig = jest.mocked(updateBenchmarkConfig);
const mockFindExperimentReservedModelIds = jest.mocked(findExperimentReservedModelIds);

// Test-fixture boundary: only the fields the route actually reads.
function adminUserFixture(): User {
  return { id: 'admin_123', google_user_email: 'admin@kilocode.ai' } as Partial<User> as User;
}

function putRequest(body: unknown) {
  return new NextRequest('http://localhost:3000/admin/api/auto-routing/benchmark-config', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

const validConfig = {
  classifierModels: ['google/gemini-2.5-flash-lite'],
  deciderModels: [{ id: 'openai/gpt-5-mini', reasoningEffort: null }],
  minAccuracy: 0.7,
  switchCostFactor: 3,
  maxConcurrency: 4,
  benchmarkUserId: null,
  benchmarkOrgId: null,
  classifierRepetitions: 1,
  deciderRepetitions: 1,
  classifierMaxP95LatencyMs: 1000,
  autoDeciderMinCostUsd: 15,
  autoDeciderMaxCostUsd: 25,
  updatedAt: null,
  updatedBy: null,
};

describe('PUT /admin/api/auto-routing/benchmark-config', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserFromAuth.mockResolvedValue({
      user: adminUserFixture(),
      authFailedResponse: null,
    });
    mockUpdateBenchmarkConfig.mockResolvedValue({
      status: 200,
      body: { config: validConfig },
    });
    mockGetBenchmarkConfig.mockResolvedValue({ status: 200, body: { config: null } });
    mockFindExperimentReservedModelIds.mockResolvedValue([]);
  });

  it('forwards a config whose decider models all serve every gateway chat API', async () => {
    const response = await PUT(putRequest(validConfig));
    expect(response.status).toBe(200);
    expect(mockUpdateBenchmarkConfig).toHaveBeenCalledWith(validConfig, 'admin@kilocode.ai');
  });

  it('rejects with 400 listing decider models not servable on all gateway chat APIs', async () => {
    const response = await PUT(
      putRequest({
        ...validConfig,
        deciderModels: [
          { id: 'openai/gpt-5-mini', reasoningEffort: null },
          { id: 'test-exclusive/alibaba-only', reasoningEffort: null },
        ],
      })
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('test-exclusive/alibaba-only');
    expect(body.error).toContain('chat_completions');
    expect(body.error).not.toContain('openai/gpt-5-mini (');
    expect(mockUpdateBenchmarkConfig).not.toHaveBeenCalled();
  });

  it('rejects decider models reserved by a model experiment (any status)', async () => {
    // Ownership is status-independent per .specs/model-experiments.md: a public
    // id with a draft/active/paused/completed experiment is reserved for
    // explicit user selection and must not enter kilo-auto candidate sets.
    mockFindExperimentReservedModelIds.mockResolvedValue(['preview/experimental-model']);

    const response = await PUT(
      putRequest({
        ...validConfig,
        deciderModels: [
          { id: 'openai/gpt-5-mini', reasoningEffort: null },
          { id: 'preview/experimental-model', reasoningEffort: null },
        ],
      })
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('preview/experimental-model');
    expect(body.error).toContain('model-experiment');
    expect(mockUpdateBenchmarkConfig).not.toHaveBeenCalled();
    // The check runs against the decider model ids.
    expect(mockFindExperimentReservedModelIds).toHaveBeenCalledWith([
      'openai/gpt-5-mini',
      'preview/experimental-model',
    ]);
  });

  it('rejects a schema-invalid config with 400', async () => {
    const response = await PUT(putRequest({ classifierModels: 'oops' }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid benchmark config' });
    expect(mockUpdateBenchmarkConfig).not.toHaveBeenCalled();
  });
});
