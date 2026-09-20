process.env.NEXTAUTH_SECRET ||= 'test-nextauth-secret';

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { NextResponse } from 'next/server';

// The route handlers wrapped by `withRestTiming` in this slice. Every module is
// imported through its public export so the test drives the same function the
// Next runtime does.
jest.mock('next/headers', () => ({
  headers: jest.fn().mockResolvedValue(new Headers()),
}));

jest.mock('@/lib/device-auth/device-auth', () => {
  class DeviceAuthPendingLimitError extends Error {}
  return {
    DeviceAuthPendingLimitError,
    createDeviceAuthRequest: jest.fn(),
    pollDeviceAuthRequest: jest.fn(),
    denyDeviceAuthRequest: jest.fn(),
    consumeDeviceAuthByDeviceCode: jest.fn(),
    approveDeviceAuthRequest: jest.fn(),
  };
});

jest.mock('@/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
  getUserFromSessionForCredentialIssuance: jest.fn(),
}));

jest.mock('@/lib/device-auth/device-auth-viewer-token', () => ({
  verifyDeviceAuthViewerToken: jest.fn(),
}));

jest.mock('@vercel/firewall', () => ({
  checkRateLimit: jest.fn(),
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

jest.mock('@/lib/ai-gateway/providers/openrouter', () => ({
  ...(jest.requireActual('@/lib/ai-gateway/providers/openrouter') as Record<string, unknown>),
  getEnhancedOpenRouterModels: jest.fn(),
  getOpenRouterTranscriptionModels: jest.fn(),
}));

// The providers catalogue reads through `createCachedFetch`; an empty cache
// yields the route's controlled 503 without touching the database.
jest.mock('@/lib/cached-fetch', () => ({
  ...(jest.requireActual('@/lib/cached-fetch') as Record<string, unknown>),
  createCachedFetch: () => async () => null,
}));

import { createDeviceAuthRequest, pollDeviceAuthRequest } from '@/lib/device-auth/device-auth';
import { getUserFromAuth } from '@/lib/user/server';
import {
  getEnhancedOpenRouterModels,
  getOpenRouterTranscriptionModels,
} from '@/lib/ai-gateway/providers/openrouter';
import * as codesRoute from '@/app/api/device-auth/codes/route';
import * as codesCodeRoute from '@/app/api/device-auth/codes/[code]/route';
import * as tokenRoute from '@/app/api/device-auth/token/route';
import * as tokensRoute from '@/app/api/device-auth/tokens/route';
import * as streamTicketRoute from '@/app/api/cloud-agent-next/sessions/stream-ticket/route';
import * as openRouterRoute from '@/app/api/openrouter/[...path]/route';
import * as modelsRoute from '@/app/api/openrouter/models/route';
import * as modelsByProviderRoute from '@/app/api/openrouter/models-by-provider/route';
import * as providersRoute from '@/app/api/openrouter/providers/route';
import * as openRouterTranscriptionModelsRoute from '@/app/api/openrouter/transcription-models/route';
import * as gatewayTranscriptionModelsRoute from '@/app/api/gateway/transcription-models/route';
import * as gatewayAudioTranscriptionsRoute from '@/app/api/gateway/audio/transcriptions/route';
import * as gatewayRoute from '@/app/api/gateway/[...path]/route';
import * as gatewayModelsRoute from '@/app/api/gateway/models/route';
import * as gatewayV1ModelsRoute from '@/app/api/gateway/v1/models/route';
import * as gatewayModelsByProviderRoute from '@/app/api/gateway/models-by-provider/route';
import * as gatewayProvidersRoute from '@/app/api/gateway/providers/route';
import * as gatewayV1TranscriptionModelsRoute from '@/app/api/gateway/v1/transcription-models/route';
import * as openRouterV1TranscriptionModelsRoute from '@/app/api/openrouter/v1/transcription-models/route';

const MOBILE_HEADERS = {
  'x-kilo-client': 'mobile',
  'x-kilo-app-platform': 'ios',
  'x-kilo-app-version': '1.2.3',
  'x-kilo-request-id': 'req-123',
};

const mockCreateDeviceAuthRequest = jest.mocked(createDeviceAuthRequest);
const mockPollDeviceAuthRequest = jest.mocked(pollDeviceAuthRequest);
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

/** Only the structured timing lines, ignoring any other console output. */
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

describe('REST data routes emit one api_timing line', () => {
  test('POST /api/device-auth/codes', async () => {
    mockCreateDeviceAuthRequest.mockResolvedValue({
      code: 'ABCD-EFGH',
      userCode: 'ABCD-EFGH',
      deviceCode: 'device-secret',
      expiresAt: new Date(Date.now() + 600_000),
    });

    const response = await codesRoute.POST(
      makeRequest('https://app.kilo.ai/api/device-auth/codes')
    );

    expect(response.status).toBe(200);
    expectSingleTimingLine('/api/device-auth/codes', 'POST');
  });

  test('POST /api/device-auth/codes logs the line when the handler throws', async () => {
    mockCreateDeviceAuthRequest.mockRejectedValue(new Error('unexpected'));

    await expect(
      codesRoute.POST(makeRequest('https://app.kilo.ai/api/device-auth/codes'))
    ).rejects.toThrow('unexpected');

    expectSingleTimingLine('/api/device-auth/codes', 'POST', false);
  });

  test('GET /api/device-auth/codes/[code]', async () => {
    mockPollDeviceAuthRequest.mockResolvedValue({ status: 'pending' });

    const response = await codesCodeRoute.GET(
      makeRequest('https://app.kilo.ai/api/device-auth/codes/ABCD-EFGH', 'GET'),
      { params: Promise.resolve({ code: 'ABCD-EFGH' }) }
    );

    expect(response.status).toBe(202);
    expectSingleTimingLine('/api/device-auth/codes/[code]', 'GET');
  });

  test('DELETE /api/device-auth/codes/[code]', async () => {
    const response = await codesCodeRoute.DELETE(
      makeRequest('https://app.kilo.ai/api/device-auth/codes/ABCD-EFGH', 'DELETE'),
      { params: Promise.resolve({ code: '' }) }
    );

    expect(response.status).toBe(400);
    expectSingleTimingLine('/api/device-auth/codes/[code]', 'DELETE');
  });

  test('POST /api/device-auth/token', async () => {
    const response = await tokenRoute.POST(
      makeRequest('https://app.kilo.ai/api/device-auth/token', 'POST', '{')
    );

    expect(response.status).toBe(400);
    expectSingleTimingLine('/api/device-auth/token', 'POST');
  });

  test('POST /api/device-auth/tokens', async () => {
    const response = await tokensRoute.POST(
      makeRequest('https://app.kilo.ai/api/device-auth/tokens', 'POST', '{}')
    );

    expect(response.status).toBe(403);
    expectSingleTimingLine('/api/device-auth/tokens', 'POST');
  });

  test('POST /api/cloud-agent-next/sessions/stream-ticket', async () => {
    mockGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    } as never);

    const response = await streamTicketRoute.POST(
      makeRequest('https://app.kilo.ai/api/cloud-agent-next/sessions/stream-ticket', 'POST', '{}')
    );

    expect(response.status).toBe(401);
    expectSingleTimingLine('/api/cloud-agent-next/sessions/stream-ticket', 'POST');
  });

  test('POST /api/openrouter/[...path]', async () => {
    const response = await openRouterRoute.POST(
      makeRequest('https://app.kilo.ai/api/openrouter/not-a-path', 'POST', '{}')
    );

    expect(response.status).toBe(400);
    expectSingleTimingLine('/api/openrouter/[...path]', 'POST');
  });
});

describe('gateway catch-all', () => {
  test('still exports maxDuration', () => {
    expect(gatewayRoute.maxDuration).toBe(800);
  });

  test('a gateway pathname logs the gateway pattern only', async () => {
    const response = await gatewayRoute.POST(
      makeRequest('https://app.kilo.ai/api/gateway/not-a-path', 'POST', '{}')
    );

    expect(response.status).toBe(400);

    const lines = timingLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      type: 'api_timing',
      route: '/api/gateway/[...path]',
      method: 'POST',
      client: 'mobile',
      platform: 'ios',
      version: '1.2.3',
      requestId: 'req-123',
    });
    expect(lines.some(line => line.route === '/api/openrouter/[...path]')).toBe(false);
  });
});

// The mobile app calls dedicated route files for the model catalogue
// (`/api/openrouter/models`), the voice-input upload
// (`/api/gateway/audio/transcriptions`) and the transcription-model catalogue
// (`/api/gateway/transcription-models`). Those files shadow the catch-all, so
// each carries its own static timing pattern.
describe('dedicated data routes emit one api_timing line', () => {
  test('GET /api/openrouter/models logs the pattern when the handler rejects', async () => {
    mockGetEnhancedOpenRouterModels.mockRejectedValue(new Error('catalog down'));

    const response = await modelsRoute.GET(
      makeRequest('https://app.kilo.ai/api/openrouter/models', 'GET')
    );

    expect(response.status).toBe(500);
    expectSingleTimingLine('/api/openrouter/models', 'GET', false);
  });

  test('GET /api/openrouter/models-by-provider logs the pattern when the handler rejects', async () => {
    await expect(
      modelsByProviderRoute.GET(
        makeRequest('https://app.kilo.ai/api/openrouter/models-by-provider', 'GET')
      )
    ).rejects.toThrow('outside a request scope');

    expectSingleTimingLine('/api/openrouter/models-by-provider', 'GET', false);
  });

  test('GET /api/openrouter/providers', async () => {
    const response = await providersRoute.GET(
      makeRequest('https://app.kilo.ai/api/openrouter/providers', 'GET')
    );

    expect(response.status).toBe(503);
    expectSingleTimingLine('/api/openrouter/providers', 'GET', false);
  });

  test('GET /api/openrouter/transcription-models logs the openrouter pattern only', async () => {
    mockGetUserFromAuth.mockResolvedValue({ user: null, organizationId: null } as never);
    mockGetOpenRouterTranscriptionModels.mockResolvedValue({ data: [] } as never);

    const response = await openRouterTranscriptionModelsRoute.GET(
      makeRequest('https://app.kilo.ai/api/openrouter/transcription-models', 'GET')
    );

    expect(response.status).toBe(200);
    expectSingleTimingLine('/api/openrouter/transcription-models', 'GET');
    expect(timingLines().some(line => line.route === '/api/gateway/transcription-models')).toBe(
      false
    );
  });

  test('GET /api/gateway/transcription-models logs the gateway pattern only', async () => {
    mockGetUserFromAuth.mockResolvedValue({ user: null, organizationId: null } as never);
    mockGetOpenRouterTranscriptionModels.mockResolvedValue({ data: [] } as never);

    const response = await gatewayTranscriptionModelsRoute.GET(
      makeRequest('https://app.kilo.ai/api/gateway/transcription-models', 'GET')
    );

    expect(response.status).toBe(200);
    expectSingleTimingLine('/api/gateway/transcription-models', 'GET');
    expect(timingLines().some(line => line.route === '/api/openrouter/transcription-models')).toBe(
      false
    );
  });

  test('POST /api/gateway/audio/transcriptions', async () => {
    const response = await gatewayAudioTranscriptionsRoute.POST(
      makeRequest('https://app.kilo.ai/api/gateway/audio/transcriptions', 'POST', '{}')
    );

    expect(response.status).toBe(400);
    expectSingleTimingLine('/api/gateway/audio/transcriptions', 'POST');
  });

  test('gateway/audio/transcriptions still exports maxDuration', () => {
    expect(gatewayAudioTranscriptionsRoute.maxDuration).toBe(800);
  });
});

// A bare `export { GET } from '...'` re-exports the already timed handler by
// reference, so the alias pathname is outside the inner pattern's static prefix
// and no `api_timing` line is emitted at all. Each alias re-wraps the timed
// handler with its own pattern so the alias traffic is measured once.
describe('alias routes re-exporting a timed handler emit one api_timing line', () => {
  test('GET /api/gateway/models logs the gateway alias pattern only', async () => {
    mockGetEnhancedOpenRouterModels.mockRejectedValue(new Error('catalog down'));

    const response = await gatewayModelsRoute.GET(
      makeRequest('https://app.kilo.ai/api/gateway/models', 'GET')
    );

    expect(response.status).toBe(500);
    expectSingleTimingLine('/api/gateway/models', 'GET', false);
    expect(timingLines().some(line => line.route === '/api/openrouter/models')).toBe(false);
  });

  test('GET /api/gateway/v1/models logs the gateway alias pattern only', async () => {
    mockGetEnhancedOpenRouterModels.mockRejectedValue(new Error('catalog down'));

    const response = await gatewayV1ModelsRoute.GET(
      makeRequest('https://app.kilo.ai/api/gateway/v1/models', 'GET')
    );

    expect(response.status).toBe(500);
    expectSingleTimingLine('/api/gateway/v1/models', 'GET', false);
    expect(timingLines().some(line => line.route === '/api/openrouter/models')).toBe(false);
  });

  test('GET /api/gateway/models-by-provider logs the gateway alias pattern only', async () => {
    await expect(
      gatewayModelsByProviderRoute.GET(
        makeRequest('https://app.kilo.ai/api/gateway/models-by-provider', 'GET')
      )
    ).rejects.toThrow('outside a request scope');

    expectSingleTimingLine('/api/gateway/models-by-provider', 'GET', false);
    expect(timingLines().some(line => line.route === '/api/openrouter/models-by-provider')).toBe(
      false
    );
  });

  test('GET /api/gateway/providers logs the gateway alias pattern only', async () => {
    const response = await gatewayProvidersRoute.GET(
      makeRequest('https://app.kilo.ai/api/gateway/providers', 'GET')
    );

    expect(response.status).toBe(503);
    expectSingleTimingLine('/api/gateway/providers', 'GET', false);
    expect(timingLines().some(line => line.route === '/api/openrouter/providers')).toBe(false);
  });

  test('GET /api/gateway/v1/transcription-models logs the v1 alias pattern only', async () => {
    mockGetUserFromAuth.mockResolvedValue({ user: null, organizationId: null } as never);
    mockGetOpenRouterTranscriptionModels.mockResolvedValue({ data: [] } as never);

    const response = await gatewayV1TranscriptionModelsRoute.GET(
      makeRequest('https://app.kilo.ai/api/gateway/v1/transcription-models', 'GET')
    );

    expect(response.status).toBe(200);
    expectSingleTimingLine('/api/gateway/v1/transcription-models', 'GET');
    expect(timingLines().some(line => line.route === '/api/gateway/transcription-models')).toBe(
      false
    );
  });

  test('GET /api/openrouter/v1/transcription-models logs the v1 alias pattern only', async () => {
    mockGetUserFromAuth.mockResolvedValue({ user: null, organizationId: null } as never);
    mockGetOpenRouterTranscriptionModels.mockResolvedValue({ data: [] } as never);

    const response = await openRouterV1TranscriptionModelsRoute.GET(
      makeRequest('https://app.kilo.ai/api/openrouter/v1/transcription-models', 'GET')
    );

    expect(response.status).toBe(200);
    expectSingleTimingLine('/api/openrouter/v1/transcription-models', 'GET');
    expect(timingLines().some(line => line.route === '/api/openrouter/transcription-models')).toBe(
      false
    );
  });
});
