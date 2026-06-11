import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveCallbackToken } from '@kilocode/worker-utils';

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
