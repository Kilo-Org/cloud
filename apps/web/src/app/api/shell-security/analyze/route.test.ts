import { describe, it, expect, beforeEach } from '@jest/globals';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user/server';
import { failureResult } from '@/lib/maybe-result';
import type { User } from '@kilocode/db/schema';
import {
  checkShellSecurityRateLimit,
  recordShellSecurityScan,
} from '@/lib/shell-security/rate-limiter';
import { trackShellSecurityScanCompleted } from '@/lib/shell-security/posthog-tracking';
import { RATE_LIMIT_PER_DAY } from '@/lib/shell-security/schemas';

// Capture after() callbacks so we can flush them in tests
let afterCallbacks: (() => Promise<void>)[] = [];

jest.mock('next/server', () => {
  return {
    ...(jest.requireActual('next/server') as Record<string, unknown>),
    after: (fn: () => Promise<void>) => {
      afterCallbacks.push(fn);
    },
  };
});

jest.mock('@/lib/user/server');
jest.mock('@/lib/shell-security/rate-limiter');
jest.mock('@/lib/shell-security/posthog-tracking');
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedCheckRateLimit = jest.mocked(checkShellSecurityRateLimit);
const mockedRecordScan = jest.mocked(recordShellSecurityScan);
const mockedTrackScan = jest.mocked(trackShellSecurityScanCompleted);

function setUserAuth(id = 'user-123') {
  mockedGetUserFromAuth.mockResolvedValue({
    user: { id } as User,
    authFailedResponse: null,
    organizationId: 'org-456',
  });
}

function setRateLimitAllowed(remaining = RATE_LIMIT_PER_DAY) {
  mockedCheckRateLimit.mockResolvedValue({ allowed: true, remaining });
}

function setRateLimitExceeded() {
  mockedCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0 });
}

async function flushAfterCallbacks() {
  for (const fn of afterCallbacks) {
    await fn();
  }
  afterCallbacks = [];
}

const VALID_BODY = {
  apiVersion: '2026-04-01',
  source: { platform: 'openclaw', method: 'plugin', pluginVersion: '1.0.0' },
  audit: {
    ts: 1775491369820,
    summary: { critical: 1, warn: 0, info: 1 },
    findings: [
      {
        checkId: 'fs.config.perms_world_readable',
        severity: 'critical',
        title: 'Config file is world-readable',
        detail: '/root/.openclaw/openclaw.json mode=644',
        remediation: 'chmod 600 /root/.openclaw/openclaw.json',
      },
      {
        checkId: 'summary.attack_surface',
        severity: 'info',
        title: 'Attack surface summary',
        detail: 'groups: open=0',
        remediation: null,
      },
    ],
    deep: { gateway: { attempted: true, ok: true } },
    secretDiagnostics: [],
  },
  publicIp: '1.2.3.4',
};

function makeRequest(body: unknown = VALID_BODY) {
  return new Request('http://localhost:3000/api/shell-security/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/shell-security/analyze', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    afterCallbacks = [];
    mockedRecordScan.mockResolvedValue(undefined);
  });

  it('returns 401 when not authenticated', async () => {
    const authFailedResponse = NextResponse.json(failureResult('Unauthorized'), { status: 401 });
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse,
    });

    const { POST } = await import('./route');
    const response = await POST(makeRequest() as never);
    expect(response).toBe(authFailedResponse);
  });

  it('returns 400 for invalid JSON', async () => {
    setUserAuth();
    const { POST } = await import('./route');

    const badRequest = new Request('http://localhost:3000/api/shell-security/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });

    const response = await POST(badRequest as never);
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error.code).toBe('invalid_payload');
  });

  it('returns 400 for wrong apiVersion', async () => {
    setUserAuth();
    const { POST } = await import('./route');

    const response = await POST(makeRequest({ ...VALID_BODY, apiVersion: '2025-01-01' }) as never);
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error.code).toBe('invalid_api_version');
  });

  it('returns 400 for invalid payload', async () => {
    setUserAuth();
    const { POST } = await import('./route');

    const response = await POST(
      makeRequest({ apiVersion: '2026-04-01', source: { platform: 'bad' } }) as never
    );
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error.code).toBe('invalid_payload');
  });

  it('returns a readable zod error in the invalid_payload message, not [object Object]', async () => {
    // Regression guard: the error formatter uses
    //   JSON.stringify(z.treeifyError(parseResult.error))
    // inside a template literal. Before this fix it was
    //   ${z.treeifyError(parseResult.error)}
    // which produced "Invalid request body: [object Object]" — genuinely
    // unusable for debugging. If someone drops the JSON.stringify() call,
    // this test fails.
    setUserAuth();
    const { POST } = await import('./route');

    const response = await POST(
      makeRequest({ apiVersion: '2026-04-01', source: { platform: 'bad' } }) as never
    );
    const data = await response.json();
    expect(data.error.code).toBe('invalid_payload');
    expect(typeof data.error.message).toBe('string');
    expect(data.error.message).not.toContain('[object Object]');
    // Should surface some field-level info from the zod tree output.
    expect(data.error.message.length).toBeGreaterThan(30);
  });

  it('returns 200 with the discontinuation notice for valid request', async () => {
    setUserAuth();
    setRateLimitAllowed();
    const { POST } = await import('./route');

    const response = await POST(makeRequest() as never);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.apiVersion).toBe('2026-04-01');
    expect(data.status).toBe('success');
    // The plugin renders report.markdown verbatim, so the notice must land there.
    expect(data.report.markdown).toContain('discontinued');
    expect(data.report.markdown).toContain('openclaw plugins uninstall shell-security');
    // No analysis is performed anymore — structured fields are benign stubs.
    expect(data.report.summary).toEqual({ critical: 0, warn: 0, info: 0, passed: 0 });
    expect(data.report.findings).toEqual([]);
    expect(data.report.recommendations).toEqual([]);
    expect(data.report.grade).toBe('A');
    expect(data.report.score).toBe(100);
  });

  it('returns the same discontinuation notice for kiloclaw source', async () => {
    setUserAuth();
    setRateLimitAllowed();
    const { POST } = await import('./route');

    const kiloClawBody = {
      ...VALID_BODY,
      source: { platform: 'kiloclaw', method: 'plugin', pluginVersion: '1.0.0' },
    };
    const response = await POST(makeRequest(kiloClawBody) as never);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.report.markdown).toContain('discontinued');
    expect(data.report.findings).toEqual([]);
  });

  it('returns 429 when rate limit exceeded', async () => {
    setUserAuth();
    setRateLimitExceeded();
    const { POST } = await import('./route');

    const response = await POST(makeRequest() as never);
    expect(response.status).toBe(429);

    const data = await response.json();
    expect(data.error.code).toBe('rate_limited');
  });

  it('records scan synchronously before response', async () => {
    setUserAuth();
    setRateLimitAllowed();
    const { POST } = await import('./route');

    const response = await POST(makeRequest() as never);
    expect(response.status).toBe(200);

    // DB write happens synchronously (before response), not in after()
    expect(mockedRecordScan).toHaveBeenCalledWith(
      'user-123',
      'org-456',
      expect.objectContaining({
        apiVersion: '2026-04-01',
        source: expect.objectContaining({ platform: 'openclaw' }),
      })
    );
  });

  it('fires PostHog event in after() callback', async () => {
    setUserAuth();
    setRateLimitAllowed();
    const { POST } = await import('./route');

    await POST(makeRequest() as never);

    // PostHog fires in after() — not yet called
    expect(mockedTrackScan).not.toHaveBeenCalled();

    await flushAfterCallbacks();

    expect(mockedTrackScan).toHaveBeenCalledWith(
      expect.objectContaining({
        distinctId: 'user-123',
        userId: 'user-123',
        organizationId: 'org-456',
        sourcePlatform: 'openclaw',
        // Stub report values — no analysis runs anymore.
        findingsCritical: 0,
        grade: 'A',
        score: 100,
      })
    );
  });
});
