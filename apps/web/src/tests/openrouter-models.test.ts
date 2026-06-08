import { test, expect, describe, afterEach, beforeEach } from '@jest/globals';
import { mockOpenRouterModels, createMockResponse } from './helpers/openrouter-models.helper';
import { GET } from '../app/api/openrouter/models/route';
import { NextRequest } from 'next/server';

jest.mock('@/lib/user/server', () => ({
  getUserFromAuth: jest.fn(async () => ({
    user: { id: 'test-user-id' },
    organizationId: null,
  })),
}));

jest.mock('@/lib/model-stats/terminal-bench', () => ({
  getTerminalBenchSummaries: jest.fn(
    async () => new Map([['some-other-model', { overallScore: 0.551, avgAttemptCostUsd: 53.37 }]])
  ),
  terminalBenchFor: jest.fn((summaries: Map<string, unknown>, id: string) => summaries.get(id)),
}));

function createTestRequest(path: string) {
  return new NextRequest(new URL(path, 'http://localhost:3000'), {
    method: 'GET',
  });
}

describe('GET /api/openrouter/models', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('should handle OpenRouter API errors', async () => {
    const request = createTestRequest('/api/openrouter/models');

    global.fetch = jest.fn(() => {
      return Promise.resolve(
        createMockResponse({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          jsonData: { error: 'OpenRouter API Error' },
        })
      );
    }) as unknown as typeof fetch;

    const response = await GET(request);
    const responseData = await response.json();

    expect(response.status).toBe(500);
    expect(responseData.error).toBe('Failed to fetch models');
    expect(responseData.message).toBe('Error from OpenRouter API');
  });

  test('should handle unexpected response format', async () => {
    const request = createTestRequest('/api/openrouter/models');

    global.fetch = jest.fn(() => {
      return Promise.resolve(
        createMockResponse({
          ok: true,
          status: 200,
          statusText: 'OK',
          jsonData: { unexpected: 'format' },
        })
      );
    }) as unknown as typeof fetch;

    const response = await GET(request);
    const responseData = await response.json();

    expect(response.status).toBe(200);
    expect(responseData.unexpected).toBe('format');
  });

  test('should include defaultModel field in response', async () => {
    const request = createTestRequest('/api/openrouter/models');

    global.fetch = jest.fn(() => {
      return Promise.resolve(
        createMockResponse({
          ok: true,
          status: 200,
          statusText: 'OK',
          jsonData: mockOpenRouterModels,
        })
      );
    }) as unknown as typeof fetch;

    const response = await GET(request);
    const responseData = await response.json();

    expect(response.status).toBe(200);
    expect(responseData.data).toBeDefined();
    expect(Array.isArray(responseData.data)).toBe(true);
  });

  test('should include publishable Terminal Bench summaries for canonical models', async () => {
    const request = createTestRequest('/api/openrouter/models');

    global.fetch = jest.fn(() => {
      return Promise.resolve(
        createMockResponse({
          ok: true,
          status: 200,
          statusText: 'OK',
          jsonData: mockOpenRouterModels,
        })
      );
    }) as unknown as typeof fetch;

    const response = await GET(request);
    const responseData = await response.json();
    const model = responseData.data.find((item: { id: string }) => item.id === 'some-other-model');

    expect(response.status).toBe(200);
    expect(model.terminalBench).toEqual({ overallScore: 0.551, avgAttemptCostUsd: 53.37 });
  });
});

afterEach(() => {
  // @ts-expect-error - Reset the global fetch mock
  global.fetch = undefined;
});
