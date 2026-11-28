import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import type { BundleBinding } from '@kilocode/secrets-client';
import { deriveCallbackToken } from '@kilocode/worker-utils';
import worker from '../../src/index';
import { SECRETS_COMPARE_EVENT, SECRETS_COMPARE_REFUSED_EVENT } from '../../src/secrets-compare';

// Its own file, so its isolate has not compared yet: the first authenticated request here is an
// execution callback. STS serves a callback secret that differs from the Secrets Store copy.
// Synthetic fixture values only.
const INTERNAL = 'compare-internal-fixture-0123456789abcdef';
const CALLBACK = 'compare-callback-fixture-0123456789abcdef';
const BUNDLE_CALLBACK = 'compare-bundle-callback-fixture-0123456789';
const NEXTAUTH = 'compare-nextauth-fixture-0123456789abcdef';
const NAMESPACE = 'user/compare-user';
const TRIGGER_ID = 'compare-trigger';
const REQUEST_ID = 'compare-request';

afterEach(() => {
  vi.restoreAllMocks();
});

async function send(serviceEnv: object, secret: string) {
  const token = await deriveCallbackToken({
    secret,
    scope: 'webhook-execution-callback',
    resourceParts: [NAMESPACE, TRIGGER_ID, REQUEST_ID],
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request('https://example.com/api/callbacks/execution', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-namespace': NAMESPACE,
        'x-webhook-trigger-id': TRIGGER_ID,
        'x-webhook-request-id': REQUEST_ID,
        'X-Callback-Token': token,
      },
      body: JSON.stringify({
        sessionId: 'compare-session',
        cloudAgentSessionId: 'compare-agent-session',
        executionId: 'compare-execution',
        status: 'completed',
      }),
    }),
    serviceEnv as Env,
    ctx
  );
  const result = { status: response.status, body: await response.json() };
  await waitOnExecutionContext(ctx);
  return result;
}

it('records a callback secret mismatch under sts and never accepts the Secrets Store copy', async () => {
  const secrets = {
    INTERNAL_API_SECRET: INTERNAL,
    CALLBACK_TOKEN_SECRET: BUNDLE_CALLBACK,
    NEXTAUTH_SECRET: NEXTAUTH,
  };
  const getBundle = vi.fn<BundleBinding['getBundle']>(async () => ({
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
  }));
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const events = (name: string) =>
    log.mock.calls.filter(([event]) => event === name).map(([, r]) => r);
  const serviceEnv = {
    ...env,
    ENVIRONMENT: 'production',
    SECRETS_SOURCE: 'sts',
    SECRETS_COMPARE_ENABLED: 'true',
    STS: { getBundle },
    INTERNAL_API_SECRET: INTERNAL,
    CALLBACK_TOKEN_SECRET: CALLBACK,
    NEXTAUTH_SECRET: NEXTAUTH,
  };
  const unauthorized = { status: 401, body: { success: false, error: 'Unauthorized' } };

  const legacy = await send({ ...serviceEnv, SECRETS_COMPARE_ENABLED: undefined }, BUNDLE_CALLBACK);
  expect(legacy).toEqual({ status: 404, body: { success: false, error: 'Request not found' } });

  // No fallback: the Secrets Store copy is refused while STS serves another value.
  expect(await send(serviceEnv, CALLBACK)).toEqual(unauthorized);
  expect(await send(serviceEnv, CALLBACK)).toEqual(unauthorized);
  expect(events(SECRETS_COMPARE_REFUSED_EVENT)).toEqual([
    {
      route: 'execution-callback',
      secret: 'CALLBACK_TOKEN_SECRET',
      source: 'sts',
      result: 'mismatch',
    },
  ]);
  expect(events(SECRETS_COMPARE_EVENT)).toEqual([]);

  expect(await send(serviceEnv, BUNDLE_CALLBACK)).toEqual(legacy);
  expect(await send(serviceEnv, BUNDLE_CALLBACK)).toEqual(legacy);
  expect(getBundle).toHaveBeenCalledOnce();
  expect(events(SECRETS_COMPARE_EVENT)).toEqual([
    {
      INTERNAL_API_SECRET: true,
      CALLBACK_TOKEN_SECRET: false,
      NEXTAUTH_SECRET: true,
      route: 'execution-callback',
      source: 'sts',
      mismatched: ['CALLBACK_TOKEN_SECRET'],
    },
  ]);
  expect(events(SECRETS_COMPARE_REFUSED_EVENT)).toHaveLength(1);
  for (const value of [INTERNAL, CALLBACK, BUNDLE_CALLBACK, NEXTAUTH]) {
    expect(JSON.stringify(log.mock.calls)).not.toContain(value);
  }
});
