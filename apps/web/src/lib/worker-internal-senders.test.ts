import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import type { MintRequest, MintResult } from '@kilocode/sts-contracts';
import type * as ServiceTokenClient from '@kilocode/service-token-client';
import type { UserDeletionRequest, UserDeletionStep } from '@kilocode/db/schema';
import type { DeletionHandlerContext } from '@/lib/user/deletion-queue/deletion-types';

// The web app's senders to the six Workers' `/internal` routes under their switches: the real
// switch (`service-sender-auth.ts`), the real lazy STS module, the shared token module and the real
// token client with its cache, with only the STS mint call, the Vercel identity and the network
// faked. Do not import `jest` from '@jest/globals': the SWC transform hoists these `jest.mock`
// calls only with the global `jest`.

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@vercel/functions', () => ({
  getCache: jest.fn(() => ({})),
  waitUntil: jest.fn(),
}));
jest.mock('@kilocode/service-token-client/vercel', () => ({
  vercelIdentity: jest.fn(() => async () => 'exchanged-identity-token'),
}));

const mockMint = jest.fn<Promise<MintResult>, [MintRequest]>();
jest.mock('@kilocode/service-token-client', () => {
  const actual: typeof ServiceTokenClient = jest.requireActual('@kilocode/service-token-client');
  return {
    ...actual,
    createHttpServiceTokens: () =>
      actual.createServiceTokens(request => mockMint(request), { attemptTimeoutMs: 1_000 }),
  };
});
jest.mock('@/lib/auth/kilo-token-signing', () => ({
  generateBoundedInternalServiceToken: jest.fn(() => 'bounded-token'),
}));
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({ db: {} }));

const SECRET = 'legacy-internal-secret';
const PRODUCTION = { VERCEL_ENV: 'production', VERCEL_TARGET_ENV: 'production' };
const URLS = {
  SECURITY_SYNC_WORKER_URL: 'https://security-sync.test.example.com',
  SECURITY_AUTO_ANALYSIS_WORKER_URL: 'https://security-auto-analysis.test.example.com',
  MODEL_EVAL_INGEST_URL: 'https://model-eval-ingest.test.example.com',
  WEBHOOK_AGENT_URL: 'https://hooks.test.example.com',
  NOTIFICATIONS_WORKER_URL: 'https://notifications.test.example.com',
  SESSION_INGEST_WORKER_URL: 'https://session-ingest.test.example.com',
};
const SESSION_SYNC_WORKER_URL = 'https://session-sync.test.example.com';
const OWNER = { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
const USER_ID = 'usr_erase';

/** One edge: its switch, what one call sends, and how a call without a credential ends. */
type Edge = {
  name: string;
  variable: string;
  url: string;
  legacyHeader: string;
  target: { audience: string; scope: string };
  /** The Worker's success answer; a fresh body per call. */
  answer: () => Response;
  /**
   * Imports the client and returns one call. Dynamic on purpose: a client resolves its switch at
   * module load, so each case imports it afresh after `jest.resetModules` with its own config.
   */
  load: () => Promise<() => Promise<unknown>>;
  /** A call without a credential rejects, or resolves `false` for a never-rejecting sender. */
  refusal: 'rejects' | 'false';
};

const commandAccepted = () =>
  Response.json(
    { success: true, accepted: true, commandId: 'cmd-1', runId: 'run-1', messageId: 'msg-1' },
    { status: 202 }
  );

const context: DeletionHandlerContext = {
  requestId: 'request-1',
  stepKey: 'cli_v2_sessions' as DeletionHandlerContext['stepKey'],
  claimToken: 'claim-1',
  deadlineAt: Date.now() + 3_600_000,
  remainingMs: () => 3_600_000,
  signal: new AbortController().signal,
};

const EDGES: Edge[] = [
  {
    name: 'security-sync manual sync',
    variable: 'SECURITY_SYNC_SENDER_AUTH',
    url: `${URLS.SECURITY_SYNC_WORKER_URL}/internal/manual-sync`,
    legacyHeader: 'x-internal-api-key',
    target: { audience: 'security-sync', scope: 'security-sync:manual-sync.enqueue' },
    answer: commandAccepted,
    load: async () => {
      const { submitManualSecuritySync } =
        await import('@/lib/security-agent/services/manual-sync-client');
      return () => submitManualSecuritySync({ owner: OWNER, actor: { id: 'user-1' } });
    },
    refusal: 'rejects',
  },
  {
    name: 'security-sync dismiss finding',
    variable: 'SECURITY_SYNC_SENDER_AUTH',
    url: `${URLS.SECURITY_SYNC_WORKER_URL}/internal/dismiss-finding`,
    legacyHeader: 'x-internal-api-key',
    target: { audience: 'security-sync', scope: 'security-sync:dismiss-finding.enqueue' },
    answer: commandAccepted,
    load: async () => {
      const { submitManualFindingDismissal } =
        await import('@/lib/security-agent/services/manual-dismiss-client');
      return () =>
        submitManualFindingDismissal({
          owner: OWNER,
          actor: { id: 'user-1' },
          findingId: 'finding-1',
          installationId: 'installation-1',
          reason: 'fix_started',
        });
    },
    refusal: 'rejects',
  },
  {
    name: 'security-auto-analysis manual analysis',
    variable: 'SECURITY_AUTO_ANALYSIS_SENDER_AUTH',
    url: `${URLS.SECURITY_AUTO_ANALYSIS_WORKER_URL}/internal/manual-analysis-start`,
    legacyHeader: 'x-internal-api-key',
    target: { audience: 'security-auto-analysis', scope: 'security-auto-analysis:internal.call' },
    answer: () =>
      Response.json({ success: true, accepted: true, commandId: 'cmd-1' }, { status: 202 }),
    load: async () => {
      const { submitManualAnalysisStart } =
        await import('@/lib/security-agent/services/manual-analysis-client');
      return () =>
        submitManualAnalysisStart({ findingId: 'finding-1', owner: OWNER, actorUserId: 'user-1' });
    },
    refusal: 'rejects',
  },
  {
    name: 'security-auto-analysis remediation cancel',
    variable: 'SECURITY_AUTO_ANALYSIS_SENDER_AUTH',
    url: `${URLS.SECURITY_AUTO_ANALYSIS_WORKER_URL}/internal/remediation/cancel`,
    legacyHeader: 'x-internal-api-key',
    target: { audience: 'security-auto-analysis', scope: 'security-auto-analysis:internal.call' },
    answer: () => Response.json({ success: true, status: 'cancelled' }),
    load: async () => {
      const { submitRemediationCancellation } =
        await import('@/lib/security-agent/services/manual-remediation-client');
      return () =>
        submitRemediationCancellation({
          attemptId: 'attempt-1',
          owner: OWNER,
          actorUserId: 'user-1',
        });
    },
    refusal: 'rejects',
  },
  {
    name: 'model-eval-ingest sync',
    variable: 'MODEL_EVAL_INGEST_SENDER_AUTH',
    url: `${URLS.MODEL_EVAL_INGEST_URL}/internal/sync`,
    legacyHeader: 'x-internal-api-key',
    target: { audience: 'model-eval-ingest', scope: 'model-eval-ingest:internal.call' },
    answer: () =>
      Response.json({ success: true, inserted: 0, alreadyHad: 0, cacheRecomputes: 0, fetched: 0 }),
    load: async () => {
      const { syncModelEvalPromotions } = await import('@/lib/model-eval-ingest-client');
      return () => syncModelEvalPromotions();
    },
    refusal: 'rejects',
  },
  {
    name: 'webhook-agent-ingest trigger read',
    variable: 'WEBHOOK_AGENT_INGEST_SENDER_AUTH',
    url: `${URLS.WEBHOOK_AGENT_URL}/api/triggers/org/${OWNER.organizationId}/trigger-1`,
    legacyHeader: 'x-internal-api-key',
    target: { audience: 'webhook-agent-ingest', scope: 'webhook-agent-ingest:internal.call' },
    answer: () => Response.json({ success: true, data: { triggerId: 'trigger-1' } }),
    load: async () => {
      const { getWorkerTrigger } = await import('@/lib/webhook-agent/webhook-agent-client');
      return () => getWorkerTrigger(undefined, OWNER.organizationId, 'trigger-1');
    },
    refusal: 'rejects',
  },
  {
    name: 'session-sync user erase',
    variable: 'SESSION_SYNC_SENDER_AUTH',
    url: `${SESSION_SYNC_WORKER_URL}/internal/users/${USER_ID}/erase`,
    legacyHeader: 'x-internal-secret',
    target: { audience: 'session-sync', scope: 'session-sync:internal.call' },
    // Not 202: the handler stops after the erase call, before any database work.
    answer: () => new Response(null, { status: 503 }),
    load: async () => {
      const { handleCliV2Sessions } = await import('@/lib/user/deletion-queue/handlers/cli-v2');
      return () =>
        handleCliV2Sessions({
          request: { id: 'request-1', user_id: USER_ID } as UserDeletionRequest,
          step: { progress_json: {} } as UserDeletionStep,
          context,
        });
    },
    refusal: 'rejects',
  },
  {
    name: 'notifications dispatch',
    variable: 'NOTIFICATIONS_SENDER_AUTH',
    url: `${URLS.NOTIFICATIONS_WORKER_URL}/internal/v1/dispatch`,
    legacyHeader: 'x-internal-secret',
    target: { audience: 'notifications', scope: 'notifications:internal.call' },
    answer: () => Response.json({ perRecipient: [] }),
    load: async () => {
      const { dispatchSpendAlertPush } =
        await import('@kilocode/web-shared/lib/notifications-worker-client');
      return () =>
        dispatchSpendAlertPush({
          recipientUserIds: ['user-1'],
          scope: 'organization',
          organizationId: 'org-1',
          alertKind: 'threshold',
          scopeName: 'Acme',
          amountUsd: 5,
          thresholdUsd: 5,
          dedupeKey: 'org:org-1:threshold:push:2026-01-01T00:00:00.000Z:armed',
        });
    },
    refusal: 'false',
  },
];

const runtimeNames = ['VERCEL_ENV', 'VERCEL_TARGET_ENV', 'KILO_STS_WORKLOAD'] as const;
const savedRuntime = Object.fromEntries(runtimeNames.map(name => [name, process.env[name]]));

function setRuntime(values: Partial<Record<(typeof runtimeNames)[number], string>>): void {
  for (const name of runtimeNames) {
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

/** Loads `edge`'s client with every switch set to `auth` and returns one call of it. */
async function load(edge: Edge, auth: string | undefined): Promise<() => Promise<unknown>> {
  jest.resetModules();
  const switches = Object.fromEntries(EDGES.map(({ variable }) => [variable, auth]));
  jest.doMock('@kilocode/web-shared/lib/config.server', () => ({
    ...jest.requireActual<Record<string, unknown>>('@kilocode/web-shared/lib/config.server'),
    ...URLS,
    ...switches,
    INTERNAL_API_SECRET: SECRET,
  }));
  jest.doMock('@/lib/web-config.server', () => ({ SESSION_SYNC_WORKER_URL }));
  const call = await edge.load();
  jest.dontMock('@kilocode/web-shared/lib/config.server');
  jest.dontMock('@/lib/web-config.server');
  return call;
}

function issued(request: MintRequest): MintResult {
  return {
    status: 'ok',
    tokens: request.tokens.map(({ audience, scope }) => ({
      status: 'issued',
      audience,
      scope,
      token: `token:${scope}`,
      jti: crypto.randomUUID(),
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    })),
  };
}

let mockFetch: jest.SpiedFunction<typeof fetch>;
let consoleError: jest.SpyInstance;

beforeEach(() => {
  mockMint.mockReset();
  mockMint.mockImplementation(async request => issued(request));
  globalThis.__kilocodeInternalApiSecretRead = undefined;
  setRuntime(PRODUCTION);
  mockFetch = jest.spyOn(globalThis, 'fetch');
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  setRuntime(savedRuntime);
  jest.restoreAllMocks();
});

async function expectRefused(edge: Edge, call: () => Promise<unknown>): Promise<void> {
  if (edge.refusal === 'rejects') await expect(call()).rejects.toThrow();
  else await expect(call()).resolves.toBe(false);
}

describe.each(EDGES)('$name', edge => {
  test('legacy (unset) sends the internal secret and mints nothing', async () => {
    mockFetch.mockImplementation(async () => edge.answer());
    const call = await load(edge, undefined);
    await call();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] ?? [];
    expect(String(url)).toBe(edge.url);
    const headers = new Headers(init?.headers);
    expect(headers.get(edge.legacyHeader)).toBe(SECRET);
    expect(headers.has('authorization')).toBe(false);
    expect(init?.redirect).toBeUndefined();
    expect(mockMint).not.toHaveBeenCalled();
  });

  test('sts sends exactly one bearer for the route scope and never the secret', async () => {
    mockFetch.mockImplementation(async () => edge.answer());
    const call = await load(edge, 'sts');
    await call();

    expect(mockMint).toHaveBeenCalledTimes(1);
    expect(mockMint.mock.calls[0]?.[0]).toEqual({ tokens: [edge.target] });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] ?? [];
    expect(String(url)).toBe(edge.url);
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe(`Bearer token:${edge.target.scope}`);
    expect(headers.has(edge.legacyHeader)).toBe(false);
    expect(JSON.stringify(init)).not.toContain(SECRET);
    expect(init?.redirect).toBe('error');
  });

  test('sts holds the token per audience and scope: two calls, one mint', async () => {
    mockFetch.mockImplementation(async () => edge.answer());
    const call = await load(edge, 'sts');
    await call();
    await call();

    expect(mockMint).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    for (const [, init] of mockFetch.mock.calls) {
      expect(new Headers(init?.headers).get('authorization')).toBe(
        `Bearer token:${edge.target.scope}`
      );
    }
  });

  test('an unknown switch value sends nothing and logs the refusal', async () => {
    const call = await load(edge, 'STS');
    await expectRefused(edge, call);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockMint).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('invalid sender configuration; request refused'),
      { reason: 'invalid_auth' }
    );
  });

  test('a mint failure under sts fails the call closed: no request, no secret', async () => {
    mockMint.mockResolvedValue({ status: 'unavailable', retryAfterSeconds: 5 });
    const call = await load(edge, 'sts');
    await expectRefused(edge, call);

    expect(mockMint).toHaveBeenCalledTimes(1);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('no STS token; request refused'),
      expect.objectContaining({ reason: 'unavailable' })
    );
  });
});

test('notifications under sts in an ai-gateway build sends nothing and mints nothing', async () => {
  const [notifications] = EDGES.filter(edge => edge.variable === 'NOTIFICATIONS_SENDER_AUTH');
  if (notifications === undefined) throw new Error('notifications edge missing');
  setRuntime({ ...PRODUCTION, KILO_STS_WORKLOAD: 'ai-gateway' });
  const call = await load(notifications, 'sts');
  await expect(call()).resolves.toBe(false);

  expect(mockFetch).not.toHaveBeenCalled();
  expect(mockMint).not.toHaveBeenCalled();
  expect(consoleError).toHaveBeenCalledWith(
    expect.stringContaining('invalid sender configuration; request refused'),
    { reason: 'not_web_workload' }
  );
});
