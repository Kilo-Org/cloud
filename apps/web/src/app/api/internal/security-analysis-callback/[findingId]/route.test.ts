import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { deriveCallbackToken } from '@kilocode/worker-utils/callback-token';
import { NextRequest } from 'next/server';
import { CONTROL_PLANE_UPSTREAM_BUDGET_MS } from '@/lib/bounded-service-fetch';
import type * as routeModule from './route';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  SECURITY_AUTO_ANALYSIS_WORKER_URL: 'https://security-auto-analysis.test',
}));
jest.mock('@/lib/web-config.server', () => ({
  CALLBACK_TOKEN_SECRET: 'test-callback-token-secret',
}));

let POST: typeof routeModule.POST;

beforeAll(async () => {
  ({ POST } = await import('./route'));
});

const findingId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const attemptToken = 'attempt-token-123';
const mockFetch = jest.fn<typeof fetch>();
global.fetch = mockFetch;

async function callbackToken(): Promise<string> {
  return deriveCallbackToken({
    secret: 'test-callback-token-secret',
    scope: 'security-analysis-callback',
    resourceParts: [findingId, attemptToken],
  });
}

async function callbackRequest(options: { token?: string; payload?: unknown } = {}) {
  return new NextRequest(
    `https://web.test/api/internal/security-analysis-callback/${findingId}?attempt=${attemptToken}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Callback-Token': options.token ?? (await callbackToken()),
      },
      body: JSON.stringify(
        options.payload ?? {
          sessionId: 'session-123',
          cloudAgentSessionId: 'agent-123',
          executionId: 'exec-123',
          status: 'completed',
        }
      ),
    }
  );
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('security analysis callback rollback ingress', () => {
  it('rejects requests without scoped callback authentication', async () => {
    const response = await POST(await callbackRequest({ token: 'wrong-token' }), {
      params: Promise.resolve({ findingId }),
    });

    expect(response.status).toBe(401);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects malformed callback payload before Worker admission', async () => {
    const response = await POST(await callbackRequest({ payload: { status: 'completed' } }), {
      params: Promise.resolve({ findingId }),
    });

    expect(response.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns success only after durable Worker callback admission succeeds', async () => {
    mockFetch.mockResolvedValue(Response.json({ success: true, accepted: true }, { status: 202 }));

    const response = await POST(await callbackRequest(), {
      params: Promise.resolve({ findingId }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ success: true, accepted: true });
    expect(mockFetch).toHaveBeenCalledWith(
      `https://security-auto-analysis.test/internal/security-analysis-callback/${findingId}?attempt=${attemptToken}`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'content-type': 'application/json',
          'X-Callback-Token': await callbackToken(),
        }),
      })
    );
  });

  it('propagates Worker queue admission failure instead of acknowledging work', async () => {
    mockFetch.mockResolvedValue(Response.json({ error: 'Queue unavailable' }, { status: 503 }));

    const response = await POST(await callbackRequest(), {
      params: Promise.resolve({ findingId }),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'Queue unavailable' });
  });

  it('answers 504 when the Worker never responds, instead of holding the request open', async () => {
    const request = await callbackRequest();
    jest.useFakeTimers();
    try {
      mockFetch.mockImplementation(() => new Promise<Response>(() => {}));

      const pending = POST(request, { params: Promise.resolve({ findingId }) });
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(CONTROL_PLANE_UPSTREAM_BUDGET_MS);

      const response = await pending;
      expect(response.status).toBe(504);
      await expect(response.json()).resolves.toEqual({
        error: 'Security analysis Worker did not respond in time',
      });
    } finally {
      jest.useRealTimers();
    }
  });
});
