import { NextRequest } from 'next/server';
import type { User } from '@kilocode/db';
import {
  getBenchmarkConfig,
  updateBenchmarkConfig,
} from '@/lib/ai-gateway/auto-routing-benchmark-admin-client';
import { getUserFromAuth } from '@/lib/user/server';
import { morph_warp_grep_free_model } from '@/lib/ai-gateway/providers/morph';

jest.mock('@/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
}));

jest.mock('@/lib/ai-gateway/auto-routing-benchmark-admin-client', () => ({
  getBenchmarkConfig: jest.fn(),
  updateBenchmarkConfig: jest.fn(),
}));

import { PUT } from './route';

const mockGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockGetBenchmarkConfig = jest.mocked(getBenchmarkConfig);
const mockUpdateBenchmarkConfig = jest.mocked(updateBenchmarkConfig);

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
          { id: morph_warp_grep_free_model.public_id, reasoningEffort: null },
        ],
      })
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain(morph_warp_grep_free_model.public_id);
    expect(body.error).toContain('chat_completions');
    expect(body.error).not.toContain('openai/gpt-5-mini (');
    expect(mockUpdateBenchmarkConfig).not.toHaveBeenCalled();
  });

  it('rejects a schema-invalid config with 400', async () => {
    const response = await PUT(putRequest({ classifierModels: 'oops' }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid benchmark config' });
    expect(mockUpdateBenchmarkConfig).not.toHaveBeenCalled();
  });
});
