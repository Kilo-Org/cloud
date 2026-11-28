import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveCallbackToken } from '@kilocode/worker-utils';
import type { BundleBinding } from '@kilocode/secrets-client';
import { logger } from '../util/logger';

vi.mock('cloudflare:workers', () => ({ waitUntil: vi.fn() }));

vi.mock('../util/do-retry', () => ({
  withDORetry: async <TStub, TResult>(
    getStub: () => TStub,
    operation: (stub: TStub) => Promise<TResult>
  ): Promise<TResult> => operation(getStub()),
}));

import { callbacks } from './callbacks';

const CALLBACK_SECRET = 'test-callback-token-secret';
const NAMESPACE = 'user/user-1';
const TRIGGER_ID = 'trigger-1';
const REQUEST_ID = 'request-1';
const CLOUD_AGENT_SESSION_ID = 'cloud-agent-session-1';

const callbackPayload = {
  sessionId: 'session-1',
  cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
  executionId: 'execution-1',
  status: 'completed',
};

type CallbackHeaders = {
  namespace?: string;
  triggerId?: string;
  requestId?: string;
  callbackToken?: string;
};

function createRouteHarness(cloudAgentSessionId = CLOUD_AGENT_SESSION_ID) {
  const getRequest = vi.fn(async () => ({
    processStatus: 'inprogress',
    cloudAgentSessionId,
  }));
  const updateRequest = vi.fn(async () => undefined);
  const stub = { getRequest, updateRequest };
  const env = {
    ENVIRONMENT: 'development',
    CALLBACK_TOKEN_SECRET: { get: vi.fn(async () => CALLBACK_SECRET) },
    TRIGGER_DO: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => stub),
    },
  } as unknown as Env;

  return { env, getRequest, updateRequest };
}

function callbackHeaders(headers: CallbackHeaders): HeadersInit {
  const result: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-webhook-namespace': headers.namespace ?? NAMESPACE,
    'x-webhook-trigger-id': headers.triggerId ?? TRIGGER_ID,
    'x-webhook-request-id': headers.requestId ?? REQUEST_ID,
  };

  if (headers.callbackToken) {
    result['X-Callback-Token'] = headers.callbackToken;
  }

  return result;
}

async function requestCallback(
  env: Env,
  headers: CallbackHeaders,
  payload: Record<string, unknown> = callbackPayload
) {
  return callbacks.request(
    '/execution',
    {
      method: 'POST',
      headers: callbackHeaders(headers),
      body: JSON.stringify(payload),
    },
    env
  );
}

describe('webhook execution callback auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts a scoped callback token and updates the request', async () => {
    const { env, updateRequest } = createRouteHarness();
    const callbackToken = await deriveCallbackToken({
      secret: CALLBACK_SECRET,
      scope: 'webhook-execution-callback',
      resourceParts: [NAMESPACE, TRIGGER_ID, REQUEST_ID],
    });

    const response = await requestCallback(env, { callbackToken });

    expect(response.status).toBe(200);
    expect(updateRequest).toHaveBeenCalledWith(
      REQUEST_ID,
      expect.objectContaining({ process_status: 'success' })
    );
  });

  it('prefers a validated structured failure message over the legacy message', async () => {
    const { env, updateRequest } = createRouteHarness();
    const callbackToken = await deriveCallbackToken({
      secret: CALLBACK_SECRET,
      scope: 'webhook-execution-callback',
      resourceParts: [NAMESPACE, TRIGGER_ID, REQUEST_ID],
    });

    const response = await requestCallback(
      env,
      { callbackToken },
      {
        ...callbackPayload,
        status: 'failed',
        errorMessage: 'legacy error',
        failure: {
          stage: 'pre_dispatch',
          code: 'workspace_setup_failed',
          subtype: 'git_clone_timeout',
          attempts: 2,
          message: 'Repository clone timed out',
        },
      }
    );

    expect(response.status).toBe(200);
    expect(updateRequest).toHaveBeenCalledWith(
      REQUEST_ID,
      expect.objectContaining({ error_message: 'Repository clone timed out' })
    );
  });

  it('falls back to the legacy error message when failure is absent', async () => {
    const { env, updateRequest } = createRouteHarness();
    const callbackToken = await deriveCallbackToken({
      secret: CALLBACK_SECRET,
      scope: 'webhook-execution-callback',
      resourceParts: [NAMESPACE, TRIGGER_ID, REQUEST_ID],
    });

    const response = await requestCallback(
      env,
      { callbackToken },
      {
        ...callbackPayload,
        status: 'failed',
        errorMessage: 'legacy error',
      }
    );

    expect(response.status).toBe(200);
    expect(updateRequest).toHaveBeenCalledWith(
      REQUEST_ID,
      expect.objectContaining({ error_message: 'legacy error' })
    );
  });

  it.each([
    { failure: { code: 'future_failure_code' } },
    { failure: { subtype: 'unknown_workspace_failure' } },
    { failure: { extra: true } },
    { failure: { attempts: -1 } },
    { failure: { message: 'x'.repeat(4_097) } },
  ])('discards incompatible failure and uses the legacy message: %o', async payloadExtension => {
    const { env, updateRequest } = createRouteHarness();
    const callbackToken = await deriveCallbackToken({
      secret: CALLBACK_SECRET,
      scope: 'webhook-execution-callback',
      resourceParts: [NAMESPACE, TRIGGER_ID, REQUEST_ID],
    });

    const response = await requestCallback(
      env,
      { callbackToken },
      {
        ...callbackPayload,
        status: 'failed',
        errorMessage: 'legacy error',
        ...payloadExtension,
      }
    );

    expect(response.status).toBe(200);
    expect(updateRequest).toHaveBeenCalledWith(
      REQUEST_ID,
      expect.objectContaining({ error_message: 'legacy error' })
    );
  });

  it.each([
    { namespace: 'user/tampered', triggerId: TRIGGER_ID, requestId: REQUEST_ID },
    { namespace: NAMESPACE, triggerId: 'trigger-tampered', requestId: REQUEST_ID },
    { namespace: NAMESPACE, triggerId: TRIGGER_ID, requestId: 'request-tampered' },
  ])('rejects identity header tampering for %o', async identity => {
    const { env, getRequest } = createRouteHarness();
    const callbackToken = await deriveCallbackToken({
      secret: CALLBACK_SECRET,
      scope: 'webhook-execution-callback',
      resourceParts: [NAMESPACE, TRIGGER_ID, REQUEST_ID],
    });

    const response = await requestCallback(env, { ...identity, callbackToken });

    expect(response.status).toBe(401);
    expect(getRequest).not.toHaveBeenCalled();
  });

  it('keeps session mismatch guard after callback authentication', async () => {
    const { env, updateRequest } = createRouteHarness('different-cloud-agent-session');
    const callbackToken = await deriveCallbackToken({
      secret: CALLBACK_SECRET,
      scope: 'webhook-execution-callback',
      resourceParts: [NAMESPACE, TRIGGER_ID, REQUEST_ID],
    });

    const response = await requestCallback(env, { callbackToken });

    expect(response.status).toBe(403);
    expect(updateRequest).not.toHaveBeenCalled();
  });
});

// Synthetic fixture values only. Each source holds a different value, so a route that checked
// against the wrong source, or fell back to it, answers differently.
const STORE_CALLBACK_SECRET = 'store-callback-fixture-0123456789abcdef';
const BUNDLE_CALLBACK_SECRET = 'bundle-callback-fixture-0123456789abcdef';

type BundleResult = Awaited<ReturnType<BundleBinding['getBundle']>>;

function bundleWith(secrets: Record<string, string>): BundleResult {
  return {
    status: 'ok',
    workload: 'cloudflare-webhook-agent-ingest',
    environment: 'production',
    etag: '"0123456789abcdef"',
    stale: false,
    fetchedAt: '2026-11-27T00:00:00.000Z',
    secrets: Object.fromEntries(
      Object.entries(secrets).map(([name, value]) => [name, { value, version: 1 }])
    ),
    missing: [],
  };
}

/** A fresh STS binding per call: the reader keeps one bundle per binding for the isolate. */
function sourceHarness(
  environment: string | undefined,
  bundle: BundleResult | 'no-binding' = bundleWith({
    CALLBACK_TOKEN_SECRET: BUNDLE_CALLBACK_SECRET,
  })
) {
  const { env: base, getRequest, updateRequest } = createRouteHarness();
  const getBundle = vi.fn<BundleBinding['getBundle']>(async () =>
    bundle === 'no-binding' ? bundleWith({}) : bundle
  );
  const storeGet = vi.fn(async () => STORE_CALLBACK_SECRET);
  const env = {
    ...base,
    ENVIRONMENT: environment,
    CALLBACK_TOKEN_SECRET: { get: storeGet },
    STS: bundle === 'no-binding' ? undefined : { getBundle },
  } as unknown as Env;
  return { env, getBundle, storeGet, getRequest, updateRequest };
}

function tokenFor(secret: string) {
  return deriveCallbackToken({
    secret,
    scope: 'webhook-execution-callback',
    resourceParts: [NAMESPACE, TRIGGER_ID, REQUEST_ID],
  });
}

describe('webhook execution callback secrets source', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('accepts only a token from the Secrets Store value and reads no bundle in development', async () => {
    const { env, getBundle, storeGet } = sourceHarness('development');

    const fromBundle = await tokenFor(BUNDLE_CALLBACK_SECRET);
    expect((await requestCallback(env, { callbackToken: fromBundle })).status).toBe(401);
    expect((await requestCallback(env, {})).status).toBe(401);
    const fromStore = await tokenFor(STORE_CALLBACK_SECRET);
    expect((await requestCallback(env, { callbackToken: fromStore })).status).toBe(200);
    expect(storeGet).toHaveBeenCalledTimes(3);
    expect(getBundle).not.toHaveBeenCalled();
  });

  it('accepts only a bundle-value token in production and never reads the Secrets Store', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { env, getBundle, storeGet, updateRequest } = sourceHarness('production');

    expect((await requestCallback(env, {})).status).toBe(401);
    // A tokenless callback loads no bundle.
    expect(getBundle).not.toHaveBeenCalled();

    const fromStore = await tokenFor(STORE_CALLBACK_SECRET);
    expect((await requestCallback(env, { callbackToken: fromStore })).status).toBe(401);
    expect(updateRequest).not.toHaveBeenCalled();
    const fromBundle = await tokenFor(BUNDLE_CALLBACK_SECRET);
    expect((await requestCallback(env, { callbackToken: fromBundle })).status).toBe(200);
    expect(updateRequest).toHaveBeenCalledWith(
      REQUEST_ID,
      expect.objectContaining({ process_status: 'success' })
    );
    expect(getBundle).toHaveBeenCalledOnce();
    expect(storeGet).not.toHaveBeenCalled();
    const refusal = (reason: string) => [
      'Callback authentication failed',
      { route: 'execution-callback', secret: 'CALLBACK_TOKEN_SECRET', source: 'sts', reason },
    ];
    expect(
      warn.mock.calls.filter(([message]) => message === 'Callback authentication failed')
    ).toEqual([refusal('missing'), refusal('invalid')]);
  });

  it.each<[string, string | undefined, BundleResult | 'no-binding', string]>([
    ['no grant', 'production', bundleWith({}), 'not_granted'],
    ['an STS denial', 'production', { status: 'denied', reason: 'unknown_workload' }, 'denied'],
    ['no STS binding in production', 'production', 'no-binding', 'binding_missing'],
    ['a staging ENVIRONMENT', 'staging', bundleWith({}), 'unsupported_environment'],
    ['no ENVIRONMENT', undefined, bundleWith({}), 'unsupported_environment'],
  ])(
    'answers a generic 503 on %s before any Durable Object call, with no fallback',
    async (_case, environment, bundle, reason) => {
      const log = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
      const { env, getBundle, storeGet, getRequest } = sourceHarness(environment, bundle);
      const callbackToken = await tokenFor(STORE_CALLBACK_SECRET);

      const response = await requestCallback(env, { callbackToken });

      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('30');
      await expect(response.json()).resolves.toEqual({
        success: false,
        error: 'Internal key unavailable',
      });
      expect(log).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith('Webhook verifier secret unavailable', {
        route: 'execution-callback',
        reason,
      });
      expect(storeGet).not.toHaveBeenCalled();
      expect(getRequest).not.toHaveBeenCalled();
      if (environment !== 'production') expect(getBundle).not.toHaveBeenCalled();
    }
  );
});
