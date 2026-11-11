jest.mock('./upstream-attempt', () => ({
  sendUpstreamAttempt: jest.fn(),
}));

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { NextResponse } from 'next/server';
import { EmptyFraudDetectionHeaders } from '@kilocode/web-shared/lib/fraud-detection-headers';
import type { ProviderRoute } from './get-provider';
import type { UserByokProviderId } from './openrouter/inference-provider-id';
import type { ByokFailoverAttempt } from './routing-decision';
import type { Provider, ProviderType } from './types';
import { sendUpstreamAttemptWithByokFailover } from './byok-failover';
import {
  sendUpstreamAttempt,
  type SendUpstreamAttemptInput,
  type SendUpstreamAttemptResult,
} from './upstream-attempt';
import { UPSTREAM_DURATION_BUDGET_MS } from './upstream-request';

const mockedSendUpstreamAttempt = jest.mocked(sendUpstreamAttempt);

function route(
  apiKey: string,
  providerId: UserByokProviderId = 'openai',
  type: ProviderType = 'direct-byok'
): ProviderRoute {
  return {
    provider: { type, apiKey } as Provider,
    userByok: [{ decryptedAPIKey: apiKey, providerId }],
    isFree: false,
    bypassAccessCheck: false,
  };
}

function failedAttempt(status: number) {
  return {
    type: 'error' as const,
    response: NextResponse.json({ error: 'failed' }, { status }),
  };
}

function upstreamFailure(status: number, body: BodyInit | null): SendUpstreamAttemptResult {
  return {
    type: 'success',
    response: new Response(body, { status }),
    toolsAvailable: [],
    toolsUsed: [],
  };
}

function upstreamJsonFailure(status: number, body: unknown) {
  return upstreamFailure(status, JSON.stringify(body));
}

function servedAttempt(): SendUpstreamAttemptResult {
  return {
    type: 'success',
    response: new Response(JSON.stringify({ id: 'chatcmpl-1', choices: [] }), { status: 200 }),
    toolsAvailable: [],
    toolsUsed: [],
  };
}

/** Failover routes resolving to the given routes in order; null stands for a route that cannot serve. */
function failoverTo(...routes: (ProviderRoute | null)[]) {
  return routes.map(next => jest.fn(async (): Promise<ProviderRoute | null> => next));
}

async function failoverAttemptsOf(result: {
  failoverAttempts: Promise<ByokFailoverAttempt[]> | null;
}): Promise<ByokFailoverAttempt[]> {
  if (!result.failoverAttempts) throw new Error('Expected failover attempts');
  return result.failoverAttempts;
}

function input(
  providerContext: ProviderRoute
): Omit<SendUpstreamAttemptInput, 'upstreamDurationBudgetMs'> {
  return {
    providerContext,
    requestedModel: 'openai/gpt-4o',
    request: { kind: 'chat_completions', body: { model: 'openai/gpt-4o', messages: [] } },
    fraudHeaders: EmptyFraudDetectionHeaders,
    userId: 'user-1',
    organizationId: null,
    sessionId: null,
    taskId: null,
    isNonTrialEnterprise: false,
    search: '',
    method: 'POST',
    dataRegion: null,
  };
}

describe('sendUpstreamAttemptWithByokFailover upstream budget', () => {
  let now = 0;

  beforeEach(() => {
    jest.clearAllMocks();
    now = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('gives a failover attempt only what the earlier attempts left of the budget', async () => {
    const next = route('failover-key');
    mockedSendUpstreamAttempt.mockImplementationOnce(async () => {
      now += 120_000.4;
      return failedAttempt(503);
    });
    mockedSendUpstreamAttempt.mockResolvedValueOnce(failedAttempt(500));

    const result = await sendUpstreamAttemptWithByokFailover(
      input(route('primary-key')),
      failoverTo(next)
    );

    expect(result.providerContext).toBe(next);
    expect(mockedSendUpstreamAttempt).toHaveBeenCalledTimes(2);
    expect(mockedSendUpstreamAttempt.mock.calls[0]?.[0].upstreamDurationBudgetMs).toBe(
      UPSTREAM_DURATION_BUDGET_MS
    );
    expect(mockedSendUpstreamAttempt.mock.calls[1]?.[0].upstreamDurationBudgetMs).toBe(
      UPSTREAM_DURATION_BUDGET_MS - 120_001
    );
  });

  it('gives a route without failover keys the whole budget', async () => {
    mockedSendUpstreamAttempt.mockResolvedValueOnce(failedAttempt(503));

    await sendUpstreamAttemptWithByokFailover(input(route('primary-key')), []);

    expect(mockedSendUpstreamAttempt).toHaveBeenCalledTimes(1);
    expect(mockedSendUpstreamAttempt.mock.calls[0]?.[0].upstreamDurationBudgetMs).toBe(
      UPSTREAM_DURATION_BUDGET_MS
    );
  });

  it('returns the failure without failing over when too little of the budget is left', async () => {
    const primary = route('primary-key');
    const [failover] = failoverTo(route('failover-key'));
    mockedSendUpstreamAttempt.mockImplementationOnce(async () => {
      now += UPSTREAM_DURATION_BUDGET_MS - 1_000;
      return failedAttempt(503);
    });

    const result = await sendUpstreamAttemptWithByokFailover(input(primary), [failover]);

    expect(result.providerContext).toBe(primary);
    expect(result.attempt.type === 'error' && result.attempt.response.status).toBe(503);
    expect(mockedSendUpstreamAttempt).toHaveBeenCalledTimes(1);
    expect(failover).not.toHaveBeenCalled();
    expect(result.failoverAttempts).toBeNull();
  });

  it('returns the failure without failing over when resolving the next key leaves under 30s', async () => {
    const primary = route('primary-key');
    const failover = jest.fn(async () => {
      now = UPSTREAM_DURATION_BUDGET_MS - 29_000;
      return route('failover-key');
    });
    mockedSendUpstreamAttempt.mockImplementationOnce(async () => {
      now += 1_000;
      return failedAttempt(503);
    });

    const result = await sendUpstreamAttemptWithByokFailover(input(primary), [failover]);

    expect(failover).toHaveBeenCalledTimes(1);
    expect(mockedSendUpstreamAttempt).toHaveBeenCalledTimes(1);
    expect(result.providerContext).toBe(primary);
    expect(result.attempt.type === 'error' && result.attempt.response.status).toBe(503);
    expect(result.failoverAttempts).toBeNull();
  });

  it('measures the failover attempt budget after resolving the next key', async () => {
    mockedSendUpstreamAttempt.mockImplementationOnce(async () => {
      now += 100_000;
      return failedAttempt(503);
    });
    mockedSendUpstreamAttempt.mockResolvedValueOnce(servedAttempt());
    const failover = jest.fn(async () => {
      now += 50_000;
      return route('failover-key');
    });

    await sendUpstreamAttemptWithByokFailover(input(route('primary-key')), [failover]);

    expect(mockedSendUpstreamAttempt).toHaveBeenCalledTimes(2);
    expect(mockedSendUpstreamAttempt.mock.calls[1]?.[0].upstreamDurationBudgetMs).toBe(
      UPSTREAM_DURATION_BUDGET_MS - 150_000
    );
  });
});

describe('sendUpstreamAttemptWithByokFailover attempts', () => {
  let now = 0;

  beforeEach(() => {
    jest.clearAllMocks();
    now = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function answerAfter(durationMs: number, attempt: SendUpstreamAttemptResult) {
    mockedSendUpstreamAttempt.mockImplementationOnce(async () => {
      now += durationMs;
      return attempt;
    });
  }

  it('records every attempt of a failover with its status, error code, and duration', async () => {
    const anthropic = route('anthropic-key', 'anthropic', 'vercel');
    const bedrock = route('bedrock-key', 'bedrock', 'vercel');
    const openrouter = route('openrouter-key', 'openrouter', 'openrouter');
    answerAfter(
      1_200.4,
      upstreamJsonFailure(429, {
        error: {
          message: 'You exceeded your current quota, please check your plan and billing details.',
          type: 'insufficient_quota',
          param: null,
          code: 'insufficient_quota',
        },
      })
    );
    answerAfter(
      310.6,
      upstreamJsonFailure(429, {
        type: 'error',
        error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded.' },
      })
    );
    answerAfter(
      30_000,
      upstreamFailure(
        503,
        JSON.stringify({
          error: 'The upstream provider closed the connection before sending a response.',
          error_type: 'upstream_disconnect',
          message: 'The upstream provider closed the connection before sending a response.',
        })
      )
    );
    answerAfter(845.5, servedAttempt());

    const result = await sendUpstreamAttemptWithByokFailover(
      input(route('openai-key', 'openai', 'vercel')),
      failoverTo(anthropic, bedrock, openrouter)
    );

    expect(result.providerContext).toBe(openrouter);
    const failoverAttempts = await failoverAttemptsOf(result);
    expect(failoverAttempts).toEqual([
      {
        provider_type: 'vercel',
        byok_provider_ids: ['openai'],
        status: 429,
        error_code: 'insufficient_quota',
        duration_ms: 1_200,
        outcome: 'failed-over',
      },
      {
        provider_type: 'vercel',
        byok_provider_ids: ['anthropic'],
        status: 429,
        error_code: 'rate_limit_error',
        duration_ms: 311,
        outcome: 'failed-over',
      },
      {
        provider_type: 'vercel',
        byok_provider_ids: ['bedrock'],
        status: 503,
        error_code: 'upstream_disconnect',
        duration_ms: 30_000,
        outcome: 'failed-over',
      },
      {
        provider_type: 'openrouter',
        byok_provider_ids: ['openrouter'],
        status: 200,
        duration_ms: 846,
        outcome: 'served',
      },
    ]);
    expect(failoverAttempts.at(-1)).not.toHaveProperty('error_code');
    expect(JSON.stringify(failoverAttempts)).not.toMatch(/quota, please|request tokens|closed/);
  });

  it('records a gateway error response from the upstream request itself', async () => {
    answerAfter(40, {
      type: 'error',
      response: NextResponse.json(
        { error: 'The upstream provider did not respond.', error_type: 'upstream_disconnect' },
        { status: 503 }
      ),
    });
    answerAfter(60, servedAttempt());

    const result = await sendUpstreamAttemptWithByokFailover(
      input(route('primary-key')),
      failoverTo(route('failover-key', 'anthropic'))
    );

    expect(
      (await failoverAttemptsOf(result)).map(({ status, error_code }) => ({ status, error_code }))
    ).toEqual([{ status: 503, error_code: 'upstream_disconnect' }, { status: 200 }]);
  });

  it('records a final failure with its code and leaves its body readable', async () => {
    const lastBody = {
      error: {
        message: 'Rate limit reached for requests',
        type: 'requests',
        code: 'rate_limit_exceeded',
      },
    };
    answerAfter(100, upstreamJsonFailure(500, { error: { code: 'server_error' } }));
    answerAfter(200, upstreamJsonFailure(429, lastBody));

    const result = await sendUpstreamAttemptWithByokFailover(
      input(route('primary-key')),
      failoverTo(route('failover-key', 'anthropic', 'vercel'))
    );

    expect(await failoverAttemptsOf(result)).toEqual([
      {
        provider_type: 'direct-byok',
        byok_provider_ids: ['openai'],
        status: 500,
        error_code: 'server_error',
        duration_ms: 100,
        outcome: 'failed-over',
      },
      {
        provider_type: 'vercel',
        byok_provider_ids: ['anthropic'],
        status: 429,
        error_code: 'rate_limit_exceeded',
        duration_ms: 200,
        outcome: 'failed',
        stop_reason: 'no-keys-left',
      },
    ]);
    if (result.attempt.type === 'invalid-openrouter-model') throw new Error('Expected a response');
    expect(result.attempt.response.bodyUsed).toBe(false);
    expect(await result.attempt.response.json()).toEqual(lastBody);
  });

  it('records a final upstream request failure and leaves its body readable', async () => {
    answerAfter(100, upstreamJsonFailure(500, { error: { code: 'server_error' } }));
    answerAfter(5, {
      type: 'error',
      response: NextResponse.json(
        { error: 'unreachable', error_type: 'upstream_disconnect' },
        { status: 503 }
      ),
    });

    const result = await sendUpstreamAttemptWithByokFailover(
      input(route('primary-key')),
      failoverTo(route('failover-key', 'anthropic'))
    );

    expect((await failoverAttemptsOf(result)).at(-1)).toMatchObject({
      status: 503,
      error_code: 'upstream_disconnect',
      outcome: 'failed',
    });
    if (result.attempt.type === 'invalid-openrouter-model') throw new Error('Expected a response');
    expect(await result.attempt.response.json()).toEqual({
      error: 'unreachable',
      error_type: 'upstream_disconnect',
    });
  });

  it('records a final model OpenRouter does not list as a failed 404', async () => {
    answerAfter(100, upstreamJsonFailure(500, { error: { code: 'server_error' } }));
    answerAfter(5, { type: 'invalid-openrouter-model' });
    const [failover, third] = failoverTo(
      route('failover-key', 'openrouter', 'openrouter'),
      route('third-key', 'anthropic')
    );

    const result = await sendUpstreamAttemptWithByokFailover(input(route('primary-key')), [
      failover,
      third,
    ]);

    expect(failover).toHaveBeenCalledTimes(1);
    expect(third).not.toHaveBeenCalled();

    expect((await failoverAttemptsOf(result)).at(-1)).toEqual({
      provider_type: 'openrouter',
      byok_provider_ids: ['openrouter'],
      status: 404,
      duration_ms: 5,
      outcome: 'failed',
      stop_reason: 'model-unavailable',
    });
  });

  it('records that failover stopped when the budget ran out with keys left', async () => {
    answerAfter(100, upstreamJsonFailure(500, { error: { code: 'server_error' } }));
    answerAfter(
      UPSTREAM_DURATION_BUDGET_MS - 10_000,
      upstreamJsonFailure(503, { error_type: 'upstream_disconnect' })
    );
    const [failover, third] = failoverTo(
      route('failover-key', 'anthropic'),
      route('third-key', 'openrouter', 'openrouter')
    );

    const result = await sendUpstreamAttemptWithByokFailover(input(route('primary-key')), [
      failover,
      third,
    ]);

    expect(failover).toHaveBeenCalledTimes(1);
    expect(third).not.toHaveBeenCalled();
    expect((await failoverAttemptsOf(result)).at(-1)).toMatchObject({
      byok_provider_ids: ['anthropic'],
      outcome: 'failed',
      stop_reason: 'budget-exhausted',
    });
  });

  it('records that failover stopped when the client disconnected', async () => {
    const controller = new AbortController();
    answerAfter(100, upstreamJsonFailure(500, { error: { code: 'server_error' } }));
    mockedSendUpstreamAttempt.mockImplementationOnce(async () => {
      controller.abort();
      return upstreamJsonFailure(500, { error: { code: 'server_error' } });
    });
    const [failover, third] = failoverTo(
      route('failover-key', 'anthropic'),
      route('third-key', 'openrouter', 'openrouter')
    );

    const result = await sendUpstreamAttemptWithByokFailover(
      { ...input(route('primary-key')), signal: controller.signal },
      [failover, third]
    );

    expect(failover).toHaveBeenCalledTimes(1);
    expect(third).not.toHaveBeenCalled();
    expect((await failoverAttemptsOf(result)).at(-1)).toMatchObject({
      outcome: 'failed',
      stop_reason: 'client-disconnected',
    });
  });

  it('records nothing when the first key serves the request', async () => {
    answerAfter(100, servedAttempt());
    const failoverRoutes = failoverTo(route('failover-key', 'anthropic'));

    const result = await sendUpstreamAttemptWithByokFailover(
      input(route('primary-key')),
      failoverRoutes
    );

    expect(result.failoverAttempts).toBeNull();
    expect(failoverRoutes[0]).not.toHaveBeenCalled();
  });

  it('records nothing when no failover route can serve the request', async () => {
    answerAfter(100, upstreamJsonFailure(429, { error: { code: 'insufficient_quota' } }));
    const failoverRoutes = failoverTo(null, null);

    const result = await sendUpstreamAttemptWithByokFailover(
      input(route('primary-key')),
      failoverRoutes
    );

    expect(result.failoverAttempts).toBeNull();
    expect(failoverRoutes[0]).toHaveBeenCalledTimes(1);
    expect(failoverRoutes[1]).toHaveBeenCalledTimes(1);
    expect(mockedSendUpstreamAttempt).toHaveBeenCalledTimes(1);
    if (result.attempt.type === 'invalid-openrouter-model') throw new Error('Expected a response');
    expect(await result.attempt.response.json()).toEqual({
      error: { code: 'insufficient_quota' },
    });
  });

  it('records nothing for a route without failover keys', async () => {
    answerAfter(100, upstreamJsonFailure(429, { error: { code: 'insufficient_quota' } }));

    const result = await sendUpstreamAttemptWithByokFailover(input(route('primary-key')), []);

    expect(result.failoverAttempts).toBeNull();
  });

  it('skips failover routes that cannot serve the request', async () => {
    answerAfter(100, upstreamJsonFailure(500, { error: { code: 'server_error' } }));
    answerAfter(200, servedAttempt());
    const anthropic = route('anthropic-key', 'anthropic', 'vercel');
    const failoverRoutes = failoverTo(null, anthropic, route('third-key', 'openrouter'));

    const result = await sendUpstreamAttemptWithByokFailover(
      input(route('primary-key')),
      failoverRoutes
    );

    expect(result.providerContext).toBe(anthropic);
    expect(mockedSendUpstreamAttempt.mock.calls[1]?.[0].providerContext).toBe(anthropic);
    expect(failoverRoutes.map(resolveRoute => resolveRoute.mock.calls.length)).toEqual([1, 1, 0]);
    expect(
      (await failoverAttemptsOf(result)).map(({ byok_provider_ids, outcome }) => ({
        byok_provider_ids,
        outcome,
      }))
    ).toEqual([
      { byok_provider_ids: ['openai'], outcome: 'failed-over' },
      { byok_provider_ids: ['anthropic'], outcome: 'served' },
    ]);
  });

  it('stops with no keys left when only routes that cannot serve remain', async () => {
    answerAfter(100, upstreamJsonFailure(500, { error: { code: 'server_error' } }));
    answerAfter(200, upstreamJsonFailure(429, { error: { code: 'rate_limit_exceeded' } }));
    const anthropic = route('anthropic-key', 'anthropic', 'vercel');
    const failoverRoutes = failoverTo(anthropic, null, null);

    const result = await sendUpstreamAttemptWithByokFailover(
      input(route('primary-key')),
      failoverRoutes
    );

    expect(result.providerContext).toBe(anthropic);
    expect(mockedSendUpstreamAttempt).toHaveBeenCalledTimes(2);
    expect(failoverRoutes.map(resolveRoute => resolveRoute.mock.calls.length)).toEqual([1, 1, 1]);
    expect((await failoverAttemptsOf(result)).at(-1)).toMatchObject({
      byok_provider_ids: ['anthropic'],
      status: 429,
      outcome: 'failed',
      stop_reason: 'no-keys-left',
    });
  });

  it.each([
    { name: 'a code with spaces', body: '{"error":{"code":"quota exceeded for org-123"}}' },
    {
      name: 'a code over 64 characters',
      body: JSON.stringify({ error: { code: 'x'.repeat(65) } }),
    },
    { name: 'an empty code', body: '{"error":{"code":""}}' },
    { name: 'a numeric code', body: '{"error":{"code":429,"message":"Too many requests"}}' },
    { name: 'a string error', body: '{"error":"rate limited"}' },
    { name: 'a JSON array', body: '[{"code":"rate_limit"}]' },
    { name: 'a non-JSON body', body: 'upstream exploded: insufficient_quota' },
    { name: 'an empty body', body: '' },
    { name: 'no body', body: null },
  ])('records no error code for $name', async ({ body }) => {
    answerAfter(100, upstreamFailure(429, body));
    answerAfter(100, servedAttempt());

    const result = await sendUpstreamAttemptWithByokFailover(
      input(route('primary-key')),
      failoverTo(route('failover-key', 'anthropic'))
    );

    const [failed, served] = await failoverAttemptsOf(result);
    expect(failed).toMatchObject({ status: 429, outcome: 'failed-over' });
    expect(failed).not.toHaveProperty('error_code');
    expect(served).toMatchObject({ status: 200, outcome: 'served' });
  });

  it.each([
    {
      name: 'the gateway error type over the provider code',
      body: { error: { code: 'provider_code' }, error_type: 'context_length_exceeded' },
      code: 'context_length_exceeded',
    },
    {
      name: 'the provider code over its type',
      body: { error: { code: 'rate_limit_exceeded', type: 'requests' } },
      code: 'rate_limit_exceeded',
    },
    {
      name: 'the provider type when its code is not a string',
      body: { error: { code: 429, type: 'rate_limit_error' } },
      code: 'rate_limit_error',
    },
    {
      name: 'a top-level code',
      body: { code: 'model_not_found', message: 'Model not found' },
      code: 'model_not_found',
    },
    {
      name: 'an identifier with dots, colons, and dashes',
      body: { error: { code: 'Throttling.Exception:v2-rate' } },
      code: 'Throttling.Exception:v2-rate',
    },
  ])('records $name', async ({ body, code }) => {
    answerAfter(100, upstreamJsonFailure(429, body));
    answerAfter(100, servedAttempt());

    const result = await sendUpstreamAttemptWithByokFailover(
      input(route('primary-key')),
      failoverTo(route('failover-key', 'anthropic'))
    );

    const [failed] = await failoverAttemptsOf(result);
    expect(failed?.error_code).toBe(code);
  });

  it('records no error code for an error body over 16k characters', async () => {
    const body = JSON.stringify({
      error: { code: 'insufficient_quota', message: 'x'.repeat(16 * 1024) },
    });
    answerAfter(100, upstreamFailure(429, body));
    answerAfter(100, servedAttempt());

    const result = await sendUpstreamAttemptWithByokFailover(
      input(route('primary-key')),
      failoverTo(route('failover-key', 'anthropic'))
    );

    const [failed] = await failoverAttemptsOf(result);
    expect(failed).toMatchObject({ status: 429, outcome: 'failed-over' });
    expect(failed).not.toHaveProperty('error_code');
  });

  it('stops reading an error body that does not finish within a second', async () => {
    jest.useFakeTimers({ doNotFake: ['performance'] });
    const cancel = jest.fn();
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"error":{"code":"insufficient_quota"'));
      },
      cancel,
    });
    answerAfter(100, upstreamFailure(429, stalled));
    answerAfter(100, servedAttempt());

    const result = await sendUpstreamAttemptWithByokFailover(
      input(route('primary-key')),
      failoverTo(route('failover-key', 'anthropic'))
    );
    expect(mockedSendUpstreamAttempt).toHaveBeenCalledTimes(2);
    expect(cancel).not.toHaveBeenCalled();

    let attemptsSettled = false;
    const attemptsRead = failoverAttemptsOf(result).finally(() => {
      attemptsSettled = true;
    });
    await jest.advanceTimersByTimeAsync(999);
    expect(attemptsSettled).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);

    expect(cancel).toHaveBeenCalled();
    const [failed, served] = await attemptsRead;
    expect(failed).toMatchObject({ status: 429, outcome: 'failed-over' });
    expect(failed).not.toHaveProperty('error_code');
    expect(served?.outcome).toBe('served');
  });

  it('sends the next attempt before a slow failed error body finishes', async () => {
    let bodyFinished = false;
    let finishBody: () => void = () => {};
    const slowBody = new ReadableStream<Uint8Array>({
      start(controller) {
        finishBody = () => {
          controller.enqueue(new TextEncoder().encode('{"error":{"code":"insufficient_quota"}}'));
          controller.close();
          bodyFinished = true;
        };
      },
    });
    let bodyFinishedAtNextAttempt: boolean | undefined;
    answerAfter(100, upstreamFailure(429, slowBody));
    mockedSendUpstreamAttempt.mockImplementationOnce(async () => {
      bodyFinishedAtNextAttempt = bodyFinished;
      return servedAttempt();
    });

    const result = await sendUpstreamAttemptWithByokFailover(
      input(route('primary-key')),
      failoverTo(route('failover-key', 'anthropic'))
    );

    expect(mockedSendUpstreamAttempt).toHaveBeenCalledTimes(2);
    expect(bodyFinishedAtNextAttempt).toBe(false);
    finishBody();
    const [failed] = await failoverAttemptsOf(result);
    expect(failed).toMatchObject({
      status: 429,
      error_code: 'insufficient_quota',
      outcome: 'failed-over',
    });
  });

  it('measures each attempt only until its upstream answered', async () => {
    answerAfter(250.2, upstreamJsonFailure(500, { error: { code: 'server_error' } }));
    answerAfter(750.7, servedAttempt());
    const failover = jest.fn(async () => {
      now += 5_000;
      return route('failover-key', 'anthropic');
    });

    const result = await sendUpstreamAttemptWithByokFailover(input(route('primary-key')), [
      failover,
    ]);

    expect((await failoverAttemptsOf(result)).map(attempt => attempt.duration_ms)).toEqual([
      250, 751,
    ]);
  });
});
