import { describe, it, expect, beforeEach } from '@jest/globals';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { failureResult } from '@/lib/maybe-result';
import type { User } from '@kilocode/db/schema';
import {
  checkShellSecurityRateLimit,
  recordShellSecurityScan,
} from '@/lib/shell-security/rate-limiter';
import { trackShellSecurityScanCompleted } from '@/lib/shell-security/posthog-tracking';
import { getShellSecurityContent } from '@/lib/shell-security/content-loader';
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

jest.mock('@/lib/user.server');
jest.mock('@/lib/shell-security/rate-limiter');
jest.mock('@/lib/shell-security/posthog-tracking');
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

// The real content-loader queries the DB. In CI, workerSetup.ts runs
// `cleanupDbForTest()` after migrations, which truncates every table —
// including our seeded content. Mock the loader here so the route tests
// exercise deterministic content that mirrors the migration seed, without
// depending on whether the cleanup happened to preserve the seed rows.
// Fixture is installed per-test in beforeEach (resetAllMocks wipes it).
jest.mock('@/lib/shell-security/content-loader', () => {
  const actual = jest.requireActual('@/lib/shell-security/content-loader');
  return {
    ...actual,
    getShellSecurityContent: jest.fn(),
  };
});

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedCheckRateLimit = jest.mocked(checkShellSecurityRateLimit);
const mockedRecordScan = jest.mocked(recordShellSecurityScan);
const mockedTrackScan = jest.mocked(trackShellSecurityScanCompleted);
const mockedGetContent = jest.mocked(getShellSecurityContent);

// Seed-equivalent content used by the route-level tests. `jest.resetAllMocks`
// in beforeEach clears mock return values; setShellSecurityContentFixture()
// re-installs this value before each test.
const TEST_CONTENT = {
  checkCatalog: new Map([
    [
      'fs.config.perms_world_readable',
      {
        severity: 'critical' as const,
        explanation: 'The OpenClaw configuration file is readable by all users.',
        risk: 'Any process can read your secrets.',
      },
    ],
    [
      'summary.attack_surface',
      {
        severity: 'info' as const,
        explanation: 'Summary of the attack surface.',
        risk: 'More entry points mean more risk.',
      },
    ],
  ]),
  kiloclawCoverage: [
    {
      area: 'config_permissions',
      summary: 'Config files are restricted to owner only access',
      detail: 'KiloClaw provisions strict file permissions.',
      matchCheckIds: ['fs.config.perms_world_readable', 'fs.config.perms_group_readable'],
    },
    {
      area: 'gateway_exposure',
      summary: 'Gateway bound to localhost only',
      detail: 'Reverse proxy handles external access.',
      matchCheckIds: ['summary.attack_surface'],
    },
  ],
  content: new Map([
    ['framing.openclaw', '**How KiloClaw handles this:** {summary}. {detail}'],
    [
      'framing.kiloclaw',
      '**KiloClaw default:** {summary}. Your instance has diverged from this default configuration.',
    ],
    ['fallback.risk', 'Review this finding: {detail}'],
    ['fallback.recommendation_action', 'Address finding: {title} ({checkId})'],
    ['section.next_step', '## Next step: try KiloClaw free'],
    ['cta.body', '**Start a free trial at [kilo.ai/kiloclaw](https://kilo.ai/kiloclaw).**'],
  ]),
};

function setShellSecurityContentFixture() {
  mockedGetContent.mockResolvedValue(TEST_CONTENT);
}

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
    setShellSecurityContentFixture();
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

  it('returns 200 with structured report for valid request', async () => {
    setUserAuth();
    setRateLimitAllowed();
    const { POST } = await import('./route');

    const response = await POST(makeRequest() as never);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.apiVersion).toBe('2026-04-01');
    expect(data.status).toBe('success');
    expect(data.report.markdown).toContain('# Security Audit Report');
    expect(data.report.summary.critical).toBe(1);
    expect(data.report.findings).toHaveLength(2);
    expect(data.report.recommendations.length).toBeGreaterThan(0);
    // Grade fields are populated in both structured + markdown form.
    expect(['A', 'B', 'C', 'D', 'F']).toContain(data.report.grade);
    expect(data.report.score).toBeGreaterThanOrEqual(0);
    expect(data.report.score).toBeLessThanOrEqual(100);
    expect(data.report.markdown).toContain('## Security Grade:');
  });

  it('includes sales comparison for openclaw source', async () => {
    setUserAuth();
    setRateLimitAllowed();
    const { POST } = await import('./route');

    const response = await POST(makeRequest() as never);
    const data = await response.json();

    const configFinding = data.report.findings.find(
      (f: { checkId: string }) => f.checkId === 'fs.config.perms_world_readable'
    );
    expect(configFinding.kiloClawComparison).toContain('How KiloClaw handles this');
  });

  it('includes divergence warning for kiloclaw source', async () => {
    setUserAuth();
    setRateLimitAllowed();
    const { POST } = await import('./route');

    const kiloClawBody = {
      ...VALID_BODY,
      source: { platform: 'kiloclaw', method: 'plugin', pluginVersion: '1.0.0' },
    };
    const response = await POST(makeRequest(kiloClawBody) as never);
    const data = await response.json();

    // Probe summary.attack_surface rather than fs.config.perms_world_readable:
    // the latter is in KILOCLAW_MITIGATED_CHECKS and gets filtered out of
    // rendered findings on KiloClaw. summary.attack_surface is not mitigated
    // and still matches gateway_exposure coverage in the test fixture, so
    // the divergence framing should attach to it on KiloClaw.
    const attackSurface = data.report.findings.find(
      (f: { checkId: string }) => f.checkId === 'summary.attack_surface'
    );
    expect(attackSurface.kiloClawComparison).toContain('diverged');
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
        findingsCritical: 1,
      })
    );
  });
});
