import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockedWarnExceptInTest = jest.fn();

jest.mock('@/lib/config.server', () => ({
  AUTO_ROUTING_WORKER_URL: '',
  INTERNAL_API_SECRET: '',
}));

jest.mock('@/lib/utils.server', () => ({
  warnExceptInTest: (...args: unknown[]) => mockedWarnExceptInTest(...args),
}));

import { fetchEfficientAutoDecision } from './auto-routing-decision';
import type { EfficientDecisionParams } from './auto-routing-decision';

const originalFetch = globalThis.fetch;
const mockedFetch = jest.fn() as jest.MockedFunction<typeof globalThis.fetch>;

function makeParams(): EfficientDecisionParams {
  return {
    apiKind: 'chat_completions',
    body: {
      model: 'kilo-auto/efficient',
      stream: true,
      messages: [
        { role: 'system', content: 'You are Kilo Code.' },
        { role: 'user', content: 'Fix the parser bug.' },
      ],
    },
    requestedModel: 'kilo-auto/efficient',
    providerHints: { provider: null, providerOptions: null },
    bodyBytes: 512,
    userId: 'user-1',
    sessionId: 'task-123',
    machineId: 'machine-1',
    clientRequestId: 'req-1',
    mode: 'code',
    userAgent: 'Kilo-Code/1.2.3',
  };
}

const options = {
  workerUrl: 'https://auto-routing.example.com',
  authToken: 'classifier-token',
};

const validDecision = {
  model: 'anthropic/claude-haiku-4',
  taskType: 'implementation' as const,
  subtaskType: 'feature_development' as const,
  source: 'benchmark' as const,
  tableVersion: 'v1',
  sticky: false,
};

const validResponse = {
  cost: 0.001,
  decision: validDecision,
  classifierResult: null,
};

describe('fetchEfficientAutoDecision', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    globalThis.fetch = mockedFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns the decision on a 200 response with valid body', async () => {
    mockedFetch.mockResolvedValueOnce(new Response(JSON.stringify(validResponse), { status: 200 }));

    const result = await fetchEfficientAutoDecision(makeParams(), options);

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockedFetch.mock.calls[0];
    expect(url).toBe('https://auto-routing.example.com/decide');
    expect(init).toMatchObject({ method: 'POST' });
    const headers = init?.headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer classifier-token');
    expect(headers.get('content-type')).toBe('application/json');
    expect(result).toEqual({ decision: validDecision, costUsd: 0.001 });
  });

  it('includes denied model ids in the worker payload', async () => {
    mockedFetch.mockResolvedValueOnce(new Response(JSON.stringify(validResponse), { status: 200 }));

    await fetchEfficientAutoDecision(
      { ...makeParams(), deniedModelIds: ['openai/gpt-4o'] },
      options
    );

    const [, init] = mockedFetch.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toMatchObject({
      routingPolicy: { deniedModelIds: ['openai/gpt-4o'] },
    });
  });

  it('returns null and calls onError on a non-OK response', async () => {
    const onError = jest.fn();
    mockedFetch.mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }));

    const result = await fetchEfficientAutoDecision(makeParams(), { ...options, onError });

    expect(result).toBeNull();
    expect(onError).toHaveBeenCalledWith('Efficient auto decision request failed', {
      error: 'status 500',
    });
  });

  it('returns null and calls onError when fetch rejects (timeout/abort)', async () => {
    const onError = jest.fn();
    mockedFetch.mockRejectedValueOnce(new Error('The operation was aborted'));

    const result = await fetchEfficientAutoDecision(makeParams(), { ...options, onError });

    expect(result).toBeNull();
    expect(onError).toHaveBeenCalledWith('Efficient auto decision request failed', {
      error: 'The operation was aborted',
    });
  });

  it('returns null and calls onError on a schema-invalid response body', async () => {
    const onError = jest.fn();
    mockedFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ unexpected: 'shape' }), { status: 200 })
    );

    const result = await fetchEfficientAutoDecision(makeParams(), { ...options, onError });

    expect(result).toBeNull();
    expect(onError).toHaveBeenCalledWith('Efficient auto decision response invalid', {
      error: 'invalid_response',
    });
  });

  it('returns null when normalization fails (unclassifiable body)', async () => {
    const result = await fetchEfficientAutoDecision(
      { ...makeParams(), body: { stream: true } },
      options
    );

    expect(mockedFetch).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('returns null when workerUrl is not configured', async () => {
    const result = await fetchEfficientAutoDecision(makeParams(), {
      ...options,
      workerUrl: '',
    });

    expect(mockedFetch).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('returns null when authToken is not configured', async () => {
    const result = await fetchEfficientAutoDecision(makeParams(), {
      ...options,
      authToken: '',
    });

    expect(mockedFetch).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('returns decision: null with costUsd when the worker returns a null decision', async () => {
    mockedFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ cost: 0.001, decision: null, classifierResult: null }), {
        status: 200,
      })
    );

    const result = await fetchEfficientAutoDecision(makeParams(), options);

    expect(result).toEqual({ decision: null, costUsd: 0.001 });
  });
});
