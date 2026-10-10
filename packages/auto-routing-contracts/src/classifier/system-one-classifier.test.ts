import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedClassifierInput } from '../index';
import {
  buildClassifierRequest,
  ClassifierRunError,
  classifyWithSystemOne,
  OPENROUTER_SYSTEM_ONE_URL,
} from './system-one-classifier';

const input = {
  apiKind: 'chat_completions',
  requestedModel: 'kilo-auto/efficient',
  systemPromptPrefix: 'You are Kilo Code.',
  userPromptPrefix: 'Add a members endpoint.',
  latestUserPromptPrefix: 'Actually, first fix the failing login test.',
  messageCount: 4,
  hasTools: true,
  stream: true,
  providerHints: { provider: null, providerOptions: null },
} satisfies NormalizedClassifierInput;

const client = { apiKey: 'sk-or-test', attributionHeaders: { 'X-Title': 'Kilo Code' } };

function choice(selected: string, probabilities: Record<string, number>) {
  return { type: 'choice', choice: selected, confidence: 0.7, probabilities };
}

function answers(routeKeyProbabilities: Record<string, number>) {
  const [topRouteKey] = Object.entries(routeKeyProbabilities).sort((a, b) => b[1] - a[1])[0];
  return {
    routeKey: choice(topRouteKey, routeKeyProbabilities),
    contextComplexity: choice('medium', { small: 0.2, medium: 0.7, large: 0.1 }),
    reasoningComplexity: choice('low', { low: 0.8, medium: 0.2, high: 0 }),
    riskLevel: choice('medium', { low: 0.3, medium: 0.6, high: 0.1 }),
    executionMode: choice('code_change', { code_change: 0.9, answer_only: 0.1 }),
    requiresTools: { type: 'noul', noul: 0.92 },
  };
}

function mockFetch(response: Response) {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('classifyWithSystemOne', () => {
  it('sends the classifier questions to OpenRouter System One and decodes the answers', async () => {
    const fetchMock = mockFetch(
      Response.json({
        id: 'gen-1',
        model: 'typesafe/jev-1.13-20260917',
        answers: answers({
          'debugging/test_repair': 0.8,
          'implementation/feature_development': 0.2,
        }),
        usage: { input_tokens: 6300, output_tokens: 0, cost: 0.000265 },
      })
    );

    await expect(classifyWithSystemOne(client, input, 'typesafe/jev-1.13')).resolves.toEqual({
      cost: 0.000265,
      classifierModel: 'typesafe/jev-1.13',
      classification: {
        taskType: 'debugging',
        subtaskType: 'test_repair',
        contextComplexity: 'medium',
        reasoningComplexity: 'low',
        riskLevel: 'medium',
        executionMode: 'code_change',
        requiresTools: true,
        confidence: 0.7,
      },
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(OPENROUTER_SYSTEM_ONE_URL);
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer sk-or-test',
      'X-Title': 'Kilo Code',
    });
    expect(typeof init.body === 'string' ? JSON.parse(init.body) : null).toEqual(
      JSON.parse(JSON.stringify(buildClassifierRequest(input, 'typesafe/jev-1.13')))
    );
  });

  it('picks the task type by summed probability before the subtype', async () => {
    // The single most likely route key is implementation/*, but debugging holds more mass.
    mockFetch(
      Response.json({
        id: 'gen-2',
        model: 'typesafe/jev-1.13',
        answers: answers({
          'implementation/feature_development': 0.4,
          'debugging/bug_fixing': 0.35,
          'debugging/root_cause_analysis': 0.25,
        }),
        usage: { input_tokens: 1, output_tokens: 0, cost: 0 },
      })
    );

    const result = await classifyWithSystemOne(client, input, 'typesafe/jev-1.13');

    expect(result.classification).toMatchObject({
      taskType: 'debugging',
      subtaskType: 'bug_fixing',
    });
  });

  it('throws an http-stage error without billing or retrying when OpenRouter rejects the request', async () => {
    const fetchMock = mockFetch(new Response('{"error":"bad model"}', { status: 400 }));

    await expect(
      classifyWithSystemOne(client, input, 'google/gemini-2.5-flash-lite')
    ).rejects.toMatchObject({
      name: 'ClassifierRunError',
      failureStage: 'http_400',
      cost: null,
      classifierModel: 'google/gemini-2.5-flash-lite',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries once after a rate limit and returns the second answer', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('busy', { status: 429 }))
      .mockResolvedValueOnce(
        Response.json({
          id: 'gen-5',
          model: 'typesafe/jev-1.13',
          answers: answers({ 'investigation/repo_exploration': 1 }),
          usage: { input_tokens: 10, output_tokens: 0, cost: 0.0003 },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await classifyWithSystemOne(client, input, 'typesafe/jev-1.13');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.cost).toBe(0.0003);
    expect(result.classification.subtaskType).toBe('repo_exploration');
  });

  it('reports the billed cost when a successful response lacks a classifier answer', async () => {
    const { routeKey: _routeKey, ...withoutRouteKey } = answers({ 'debugging/bug_fixing': 1 });
    mockFetch(
      Response.json({
        id: 'gen-3',
        model: 'typesafe/jev-1.13',
        answers: withoutRouteKey,
        usage: { input_tokens: 10, output_tokens: 0, cost: 0.00042 },
      })
    );

    const error = await classifyWithSystemOne(client, input, 'typesafe/jev-1.13').catch(
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(ClassifierRunError);
    expect(error).toMatchObject({
      failureStage: 'invalid_response',
      cost: 0.00042,
      schemaIssueSummary: ['answers.routeKey:invalid_type'],
    });
  });

  it('rejects an answer outside the taxonomy', async () => {
    mockFetch(
      Response.json({
        id: 'gen-4',
        model: 'typesafe/jev-1.13',
        answers: {
          ...answers({ 'debugging/bug_fixing': 1 }),
          riskLevel: choice('extreme', { extreme: 1 }),
        },
        usage: { input_tokens: 10, output_tokens: 0, cost: 0.0001 },
      })
    );

    await expect(classifyWithSystemOne(client, input, 'typesafe/jev-1.13')).rejects.toMatchObject({
      failureStage: 'invalid_response',
      cost: 0.0001,
    });
  });

  it('wraps a network failure that persists after the retry as a transport-stage error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      })
    );

    await expect(classifyWithSystemOne(client, input, 'typesafe/jev-1.13')).rejects.toMatchObject({
      failureStage: 'transport',
      cost: null,
      message: 'fetch failed',
    });
  });
});

describe('buildClassifierRequest', () => {
  it('sends the latest user turn only when it differs from the first turn', () => {
    expect(buildClassifierRequest(input, 'm').state.latestUserPromptPrefix).toBe(
      'Actually, first fix the failing login test.'
    );
    expect(
      buildClassifierRequest({ ...input, latestUserPromptPrefix: input.userPromptPrefix }, 'm')
        .state.latestUserPromptPrefix
    ).toBeNull();
  });
});
