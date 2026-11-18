process.env.NEXTAUTH_SECRET ||= 'test-nextauth-secret';

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';

jest.mock('next/headers', () => ({
  headers: jest.fn().mockResolvedValue(new Headers()),
}));

jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

// `models-by-provider` calls `connection()` before it reads the database; a
// rejection there exercises the wrapper's "handler rejects" path without a
// database. `next/server` is spread so `NextResponse`/`NextRequest` stay real.
jest.mock('next/server', () => {
  const actual = jest.requireActual('next/server') as Record<string, unknown>;
  return {
    ...actual,
    connection: async () => {
      throw new Error('outside a request scope');
    },
  };
});

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/openrouter', () => ({
  ...(jest.requireActual('@kilocode/web-shared/lib/ai-gateway/providers/openrouter') as Record<
    string,
    unknown
  >),
  getEnhancedOpenRouterModels: jest.fn(),
  getOpenRouterTranscriptionModels: jest.fn(),
}));

// The providers catalogue reads through `createCachedFetch`; an empty cache
// yields the route's controlled 503 without touching the database.
jest.mock('@kilocode/web-shared/lib/cached-fetch', () => ({
  ...(jest.requireActual('@kilocode/web-shared/lib/cached-fetch') as Record<string, unknown>),
  createCachedFetch: () => async () => null,
}));

import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import {
  getEnhancedOpenRouterModels,
  getOpenRouterTranscriptionModels,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter';
import * as llmProxyRoute from './[...path]/route';
import * as audioTranscriptionsRoute from './audio/transcriptions/route';
import * as modelsByProviderRoute from './models-by-provider/route';
import * as modelsRoute from './models/route';
import * as providersRoute from './providers/route';
import * as transcriptionModelsRoute from './transcription-models/route';

const MOBILE_HEADERS = {
  'x-kilo-client': 'mobile',
  'x-kilo-app-platform': 'ios',
  'x-kilo-app-version': '1.2.3',
  'x-kilo-request-id': 'req-123',
};

const mockGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockGetEnhancedOpenRouterModels = jest.mocked(getEnhancedOpenRouterModels);
const mockGetOpenRouterTranscriptionModels = jest.mocked(getOpenRouterTranscriptionModels);

let logSpy: jest.SpiedFunction<typeof console.log>;

beforeEach(() => {
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.clearAllMocks();
});

afterEach(() => {
  jest.restoreAllMocks();
});

function makeRequest(url: string, method = 'POST', body?: string) {
  return new Request(url, {
    method,
    headers: { ...MOBILE_HEADERS, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body }),
  });
}

function timingLines(): Record<string, unknown>[] {
  return logSpy.mock.calls
    .map(([line]) => {
      try {
        return JSON.parse(String(line)) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((line): line is Record<string, unknown> => line?.type === 'api_timing');
}

function expectSingleTimingLine(route: string, method: string, ok = true) {
  const lines = timingLines();
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({
    type: 'api_timing',
    surface: 'rest',
    route,
    method,
    ok,
    client: 'mobile',
    platform: 'ios',
    version: '1.2.3',
    requestId: 'req-123',
  });
  expect(lines[0]?.durationMs).toEqual(expect.any(Number));
}

// The web app's gateway paths are rewritten here, so every request arrives
// under /api/v1 and is measured once, with the ai-gateway route pattern.
describe('ai-gateway REST routes emit one api_timing line', () => {
  test('POST /api/v1/[...path]', async () => {
    const response = await llmProxyRoute.POST(
      makeRequest('https://ai-gateway.kilo.ai/api/v1/not-a-path', 'POST', '{}')
    );

    expect(response.status).toBe(400);
    expectSingleTimingLine('/api/v1/[...path]', 'POST');
  });

  test('GET /api/v1/models logs the pattern when the handler rejects', async () => {
    mockGetEnhancedOpenRouterModels.mockRejectedValue(new Error('catalog down'));

    const response = await modelsRoute.GET(
      makeRequest('https://ai-gateway.kilo.ai/api/v1/models', 'GET')
    );

    expect(response.status).toBe(500);
    expectSingleTimingLine('/api/v1/models', 'GET', false);
  });

  test('GET /api/v1/models-by-provider logs the pattern when the handler rejects', async () => {
    await expect(
      modelsByProviderRoute.GET(
        makeRequest('https://ai-gateway.kilo.ai/api/v1/models-by-provider', 'GET')
      )
    ).rejects.toThrow('outside a request scope');

    expectSingleTimingLine('/api/v1/models-by-provider', 'GET', false);
  });

  test('GET /api/v1/providers', async () => {
    const response = await providersRoute.GET(
      makeRequest('https://ai-gateway.kilo.ai/api/v1/providers', 'GET')
    );

    expect(response.status).toBe(503);
    expectSingleTimingLine('/api/v1/providers', 'GET', false);
  });

  test('GET /api/v1/transcription-models', async () => {
    mockGetUserFromAuth.mockResolvedValue({ user: null, organizationId: null } as never);
    mockGetOpenRouterTranscriptionModels.mockResolvedValue({ data: [] } as never);

    const response = await transcriptionModelsRoute.GET(
      makeRequest('https://ai-gateway.kilo.ai/api/v1/transcription-models', 'GET')
    );

    expect(response.status).toBe(200);
    expectSingleTimingLine('/api/v1/transcription-models', 'GET');
  });

  test('POST /api/v1/audio/transcriptions', async () => {
    const response = await audioTranscriptionsRoute.POST(
      makeRequest('https://ai-gateway.kilo.ai/api/v1/audio/transcriptions', 'POST', '{}')
    );

    expect(response.status).toBe(400);
    expectSingleTimingLine('/api/v1/audio/transcriptions', 'POST');
  });
});
