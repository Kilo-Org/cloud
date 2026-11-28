import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import type { MintRequest, MintResult } from '@kilocode/sts-contracts';
import type * as ServiceTokenClient from '@kilocode/service-token-client';
import type { UserDeletionRequest, UserDeletionStep } from '@kilocode/db/schema';
import type { InternalDispatchSpendAlertRequest } from '@kilocode/notifications/schemas';
import { SECURITY_SERVICE_NOT_CONFIGURED_MESSAGE } from '@kilocode/app-shared/security-agent';
import { SECURITY_SERVICE_UNAVAILABLE_MESSAGE } from '@/lib/security-agent/services/security-worker-request';
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
    // Longer than every call's budget, so a hung mint is ended by the sender, not the client.
    createHttpServiceTokens: () =>
      actual.createServiceTokens(request => mockMint(request), { attemptTimeoutMs: 60_000 }),
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

/** Why a call has no credential: a refused switch, no STS token, or an empty legacy secret. */
type Failure = 'refused' | 'no_token' | 'secret_missing';

/** One route: its switch, what one call sends, and how a call without a credential ends. */
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
  /** Asserts the settled outcome of a call that had no credential. */
  expectFailure: (result: Promise<unknown>, failure: Failure) => Promise<void>;
  /** The longest the call waits for a mint; `null` where the caller's own deadline bounds it. */
  mintBudgetMs: number | null;
  /** Security routes answer an empty legacy secret with the not-configured precondition. */
  security: boolean;
};

/** Each refusal is definitive and carries the exact sentence the clients map. */
async function securityFailure(result: Promise<unknown>, failure: Failure): Promise<void> {
  const error = await result.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toMatchObject({
    name: 'TRPCError',
    code: 'PRECONDITION_FAILED',
    message:
      failure === 'no_token'
        ? SECURITY_SERVICE_UNAVAILABLE_MESSAGE
        : SECURITY_SERVICE_NOT_CONFIGURED_MESSAGE,
  });
}

async function rejects(result: Promise<unknown>): Promise<void> {
  await expect(result).rejects.toThrow();
}

function resolvesTo(value: unknown) {
  return async (result: Promise<unknown>) => {
    await expect(result).resolves.toEqual(value);
  };
}

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

const spendAlert: Omit<InternalDispatchSpendAlertRequest, 'kind'> = {
  recipientUserIds: ['user-1'],
  scope: 'organization',
  organizationId: 'org-1',
  alertKind: 'threshold',
  scopeName: 'Acme',
  amountUsd: 5,
  thresholdUsd: 5,
  dedupeKey: 'org:org-1:threshold:push:2026-01-01T00:00:00.000Z:armed',
};

const SECURITY_SYNC_TARGET = { audience: 'security-sync' };
const AUTO_ANALYSIS_TARGET = {
  audience: 'security-auto-analysis',
  scope: 'security-auto-analysis:internal.call',
};
const WEBHOOK_TARGET = {
  audience: 'webhook-agent-ingest',
  scope: 'webhook-agent-ingest:internal.call',
};
const NOTIFICATIONS_TARGET = { audience: 'notifications', scope: 'notifications:internal.call' };

const EDGES: Edge[] = [
  {
    name: 'security-sync manual sync',
    variable: 'SECURITY_SYNC_SENDER_AUTH',
    url: `${URLS.SECURITY_SYNC_WORKER_URL}/internal/manual-sync`,
    legacyHeader: 'x-internal-api-key',
    target: { ...SECURITY_SYNC_TARGET, scope: 'security-sync:manual-sync.enqueue' },
    answer: commandAccepted,
    load: async () => {
      const { submitManualSecuritySync } =
        await import('@/lib/security-agent/services/manual-sync-client');
      return () => submitManualSecuritySync({ owner: OWNER, actor: { id: 'user-1' } });
    },
    expectFailure: securityFailure,
    mintBudgetMs: 8_000,
    security: true,
  },
  {
    name: 'security-sync dismiss finding',
    variable: 'SECURITY_SYNC_SENDER_AUTH',
    url: `${URLS.SECURITY_SYNC_WORKER_URL}/internal/dismiss-finding`,
    legacyHeader: 'x-internal-api-key',
    target: { ...SECURITY_SYNC_TARGET, scope: 'security-sync:dismiss-finding.enqueue' },
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
    expectFailure: securityFailure,
    mintBudgetMs: 8_000,
    security: true,
  },
  {
    name: 'security-auto-analysis manual analysis',
    variable: 'SECURITY_AUTO_ANALYSIS_SENDER_AUTH',
    url: `${URLS.SECURITY_AUTO_ANALYSIS_WORKER_URL}/internal/manual-analysis-start`,
    legacyHeader: 'x-internal-api-key',
    target: AUTO_ANALYSIS_TARGET,
    answer: () =>
      Response.json({ success: true, accepted: true, commandId: 'cmd-1' }, { status: 202 }),
    load: async () => {
      const { submitManualAnalysisStart } =
        await import('@/lib/security-agent/services/manual-analysis-client');
      return () =>
        submitManualAnalysisStart({ findingId: 'finding-1', owner: OWNER, actorUserId: 'user-1' });
    },
    expectFailure: securityFailure,
    mintBudgetMs: 8_000,
    security: true,
  },
  {
    name: 'security-auto-analysis remediation start',
    variable: 'SECURITY_AUTO_ANALYSIS_SENDER_AUTH',
    url: `${URLS.SECURITY_AUTO_ANALYSIS_WORKER_URL}/internal/remediation/start`,
    legacyHeader: 'x-internal-api-key',
    target: AUTO_ANALYSIS_TARGET,
    answer: () =>
      Response.json(
        {
          success: true,
          accepted: true,
          admitted: true,
          remediationId: 'remediation-1',
          attemptId: 'attempt-1',
          attemptNumber: 1,
        },
        { status: 202 }
      ),
    load: async () => {
      const { submitManualRemediationStart } =
        await import('@/lib/security-agent/services/manual-remediation-client');
      return () =>
        submitManualRemediationStart({
          findingId: 'finding-1',
          owner: OWNER,
          actorUserId: 'user-1',
        });
    },
    expectFailure: securityFailure,
    mintBudgetMs: 8_000,
    security: true,
  },
  {
    name: 'security-auto-analysis remediation cancel',
    variable: 'SECURITY_AUTO_ANALYSIS_SENDER_AUTH',
    url: `${URLS.SECURITY_AUTO_ANALYSIS_WORKER_URL}/internal/remediation/cancel`,
    legacyHeader: 'x-internal-api-key',
    target: AUTO_ANALYSIS_TARGET,
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
    expectFailure: securityFailure,
    mintBudgetMs: 8_000,
    security: true,
  },
  {
    name: 'security-auto-analysis apply auto-remediation',
    variable: 'SECURITY_AUTO_ANALYSIS_SENDER_AUTH',
    url: `${URLS.SECURITY_AUTO_ANALYSIS_WORKER_URL}/internal/apply-auto-remediation`,
    legacyHeader: 'x-internal-api-key',
    target: AUTO_ANALYSIS_TARGET,
    answer: () =>
      Response.json({ success: true, accepted: true, commandId: 'cmd-1' }, { status: 202 }),
    load: async () => {
      const { submitApplyAutoRemediation } =
        await import('@/lib/security-agent/services/manual-remediation-client');
      return () =>
        submitApplyAutoRemediation({ commandId: 'cmd-1', owner: OWNER, actorUserId: 'user-1' });
    },
    expectFailure: securityFailure,
    mintBudgetMs: 8_000,
    security: true,
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
    expectFailure: rejects,
    mintBudgetMs: 8_000,
    security: false,
  },
  {
    name: 'webhook-agent-ingest trigger read',
    variable: 'WEBHOOK_AGENT_INGEST_SENDER_AUTH',
    url: `${URLS.WEBHOOK_AGENT_URL}/api/triggers/org/${OWNER.organizationId}/trigger-1`,
    legacyHeader: 'x-internal-api-key',
    target: WEBHOOK_TARGET,
    answer: () => Response.json({ success: true, data: { triggerId: 'trigger-1' } }),
    load: async () => {
      const { getWorkerTrigger } = await import('@/lib/webhook-agent/webhook-agent-client');
      return () => getWorkerTrigger(undefined, OWNER.organizationId, 'trigger-1');
    },
    expectFailure: rejects,
    mintBudgetMs: 8_000,
    security: false,
  },
  {
    name: 'webhook-agent-ingest scheduled trigger invocation',
    variable: 'WEBHOOK_AGENT_INGEST_SENDER_AUTH',
    url: `${URLS.WEBHOOK_AGENT_URL}/api/triggers/org/${OWNER.organizationId}/trigger-1/invoke`,
    legacyHeader: 'x-internal-api-key',
    target: WEBHOOK_TARGET,
    answer: () =>
      Response.json(
        { success: true, data: { requestId: '11111111-1111-4111-8111-111111111111' } },
        { status: 202 }
      ),
    load: async () => {
      const { invokeWorkerScheduledTrigger } =
        await import('@/lib/webhook-agent/webhook-agent-client');
      return () => invokeWorkerScheduledTrigger(undefined, OWNER.organizationId, 'trigger-1');
    },
    expectFailure: resolvesTo({
      success: false,
      error: 'Scheduled trigger invocation failed',
      status: 502,
    }),
    mintBudgetMs: 30_000,
    security: false,
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
    // A refused switch needs attention like a missing secret; no token throws into a retry.
    expectFailure: async (result, failure) => {
      if (failure === 'no_token') await rejects(result);
      else {
        await resolvesTo({ kind: 'needs_attention', errorCode: 'configuration_missing' })(result);
      }
    },
    // The deletion runner's task deadline bounds the step.
    mintBudgetMs: null,
    security: false,
  },
  {
    name: 'notifications dispatch',
    variable: 'NOTIFICATIONS_SENDER_AUTH',
    url: `${URLS.NOTIFICATIONS_WORKER_URL}/internal/v1/dispatch`,
    legacyHeader: 'x-internal-secret',
    target: NOTIFICATIONS_TARGET,
    answer: () => Response.json({ perRecipient: [] }),
    load: async () => {
      const { dispatchSpendAlertPush } =
        await import('@kilocode/web-shared/lib/notifications-worker-client');
      return () => dispatchSpendAlertPush(spendAlert);
    },
    expectFailure: resolvesTo(false),
    mintBudgetMs: 30_000,
    security: false,
  },
  {
    name: 'notifications glanceable refresh',
    variable: 'NOTIFICATIONS_SENDER_AUTH',
    url: `${URLS.NOTIFICATIONS_WORKER_URL}/internal/v1/glanceable-refresh`,
    legacyHeader: 'x-internal-secret',
    target: NOTIFICATIONS_TARGET,
    answer: () => new Response(null, { status: 202 }),
    load: async () => {
      const { refreshGlanceableScope } =
        await import('@kilocode/web-shared/lib/notifications-worker-client');
      return () => refreshGlanceableScope({ userId: 'user-1', organizationId: null });
    },
    expectFailure: resolvesTo(undefined),
    mintBudgetMs: 10_000,
    security: false,
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
async function load(
  edge: Edge,
  auth: string | undefined,
  secret = SECRET
): Promise<() => Promise<unknown>> {
  jest.resetModules();
  const switches = Object.fromEntries(EDGES.map(({ variable }) => [variable, auth]));
  jest.doMock('@kilocode/web-shared/lib/config.server', () => ({
    ...jest.requireActual<Record<string, unknown>>('@kilocode/web-shared/lib/config.server'),
    ...URLS,
    ...switches,
    INTERNAL_API_SECRET: secret,
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
  jest.useRealTimers();
  setRuntime(savedRuntime);
  jest.restoreAllMocks();
});

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
    await edge.expectFailure(call(), 'refused');

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockMint).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('invalid sender configuration; request refused'),
      { reason: 'invalid_auth' }
    );
  });

  test('sts outside Vercel production sends nothing and logs the refusal', async () => {
    setRuntime({ VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'staging' });
    const call = await load(edge, 'sts');
    await edge.expectFailure(call(), 'refused');

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockMint).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('invalid sender configuration; request refused'),
      { reason: 'sts_production_only' }
    );
  });

  test('a mint failure under sts fails the call closed: no request, no secret', async () => {
    mockMint.mockResolvedValue({ status: 'unavailable', retryAfterSeconds: 5 });
    const call = await load(edge, 'sts');
    await edge.expectFailure(call(), 'no_token');

    expect(mockMint).toHaveBeenCalledTimes(1);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('no STS token; request refused'),
      expect.objectContaining({ reason: 'unavailable' })
    );
  });

  const { mintBudgetMs } = edge;
  if (mintBudgetMs !== null) {
    test(`a mint still pending after ${mintBudgetMs} ms fails the call then; nothing is sent`, async () => {
      mockMint.mockReturnValue(Promise.withResolvers<MintResult>().promise);
      const call = await load(edge, 'sts');
      jest.useFakeTimers();
      let settled = false;
      const result = call();
      const markSettled = () => {
        settled = true;
      };
      result.then(markSettled, markSettled);

      await jest.advanceTimersByTimeAsync(mintBudgetMs - 1);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await edge.expectFailure(result, 'no_token');
      expect(mockMint).toHaveBeenCalledTimes(1);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  }
});

describe.each(EDGES.filter(edge => edge.security))('$name, legacy', edge => {
  test('an empty internal secret is the not-configured precondition; nothing is sent', async () => {
    const call = await load(edge, undefined, '');
    await securityFailure(call(), 'secret_missing');

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockMint).not.toHaveBeenCalled();
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
