import { test, expect, describe, afterEach, jest, beforeEach } from '@jest/globals';
import { mockOpenRouterModels, createMockResponse } from './helpers/openrouter-models.helper';
import { GET } from '../app/api/openrouter/models/route';
import { NextRequest } from 'next/server';
import { verifyApproval } from './helpers/approval.helper';
import { join } from 'node:path';

jest.mock('@/lib/user.server', () => ({
  getUserByAuthorizationHeader: jest.fn().mockImplementation(async () => ({
    user: { id: 'test-user-id' },
    authFailedResponse: null,
  })),
}));

function createTestRequest(path: string) {
  return new NextRequest(new URL(path, 'http://localhost:3000'), {
    method: 'GET',
  });
}

describe('GET /api/openrouter/models', () => {
  beforeEach(() => {
    // Reset all mocks before each test
    jest.resetAllMocks();
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

  const testName = 'openrouter-models-sorting';
  test(testName, async () => {
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

    // Verify basic response structure
    expect(response.status).toBe(200);

    // Use approval testing for the sorted models
    const approvalFilePath = join(process.cwd(), 'src/tests', `${testName}.approved.json`);
    await verifyApproval(JSON.stringify(responseData, null, 2), approvalFilePath);
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
});

afterEach(() => {
  // @ts-expect-error - Reset the global fetch mock
  global.fetch = undefined;
});
