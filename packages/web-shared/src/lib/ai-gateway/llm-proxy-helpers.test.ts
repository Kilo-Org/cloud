import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { MicrodollarUsageContext, MicrodollarUsageStats } from './processUsage.types';
import type { GatewayRequest } from './providers/openrouter/types';
import { createMockUsageContext } from '@kilocode/web-shared/tests/helpers/microdollar-usage.helper';

// `countAndStoreEditUsage` schedules the usage write through `next/server`'s
// `after()` post-response hook, which only works in a request context. Replace
// it with an immediate invocation so the test can await the work synchronously.
jest.mock('next/server', () => ({
  ...(jest.requireActual('next/server') as Record<string, unknown>),
  after: jest.fn((work: Promise<unknown> | (() => Promise<unknown>)) => {
    void (typeof work === 'function' ? work() : work);
  }),
}));

// Capture writes that would otherwise hit the database. The helper passes
// the final, post-zeroing `usageStats` to the billing wrapper, so spying
// here lets us assert on the persisted billing shape directly.
const mockedLogMicrodollarUsage = jest.fn(
  async (_stats: MicrodollarUsageStats, _ctx: MicrodollarUsageContext) => null
);
jest.mock('./processUsage', () => ({
  ...(jest.requireActual('./processUsage') as Record<string, unknown>),
  logMicrodollarUsageAndReportToBouncer: (
    stats: MicrodollarUsageStats,
    ctx: MicrodollarUsageContext
  ) => mockedLogMicrodollarUsage(stats, ctx),
}));

const mockedErrorExceptInTest = jest.fn();
jest.mock('@kilocode/web-shared/lib/utils.server', () => ({
  ...(jest.requireActual('@kilocode/web-shared/lib/utils.server') as Record<string, unknown>),
  errorExceptInTest: (...args: unknown[]) => mockedErrorExceptInTest(...args),
}));

import {
  gemma_4_26b_a4b_it_free_model,
  glyph_cluster_stealth_free_model,
  kiloExclusiveModels,
  reflection_beam_free_model,
} from './kilo-exclusive-models';
import type { KiloExclusiveModel } from './providers/kilo-exclusive-model';
import {
  captureProxyError,
  checkExclusiveModelProviderAllowed,
  countAndStoreEditUsage,
  countAndStoreFimUsage,
  countAndStoreEmbeddingUsage,
  extractEditPromptInfo,
  extractEmbeddingPromptInfo,
  extractHeaderAndLimitLength,
  extractReasoningSetting,
  getOrganizationProviderPrivacy,
  getOutputHeaders,
  lastUserPromptText,
  makeErrorReadable,
  parseEmbeddingUsageFromResponse,
  parseEditUsageFromResponse,
  parseTranscriptionUsageFromResponse,
  requestedLogprobs,
  requestedSamples,
} from './llm-proxy-helpers';

describe('getOutputHeaders', () => {
  it.each(['text/event-stream', 'text/event-stream; charset=utf-8', 'Text/Event-Stream'])(
    'prevents intermediary compression and caching of %s responses',
    contentType => {
      const response = new Response(null, {
        headers: { 'content-type': contentType, 'cache-control': 'public, max-age=3600' },
      });

      const headers = getOutputHeaders(response);

      expect(headers.get('content-type')).toBe(contentType);
      expect(headers.get('content-encoding')).toBe('identity');
      expect(headers.get('cache-control')).toBe('no-cache, no-transform');
      expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
    }
  );

  it.each(['application/json', 'text/plain', 'text/event-stream-other'])(
    'prevents intermediary caching and compression of %s responses',
    contentType => {
      const headers = getOutputHeaders(
        new Response(null, { headers: { 'content-type': contentType } })
      );

      expect(headers.get('content-encoding')).toBe('identity');
      expect(headers.get('cache-control')).toBe('no-cache, no-transform');
    }
  );
});

describe('extractReasoningSetting', () => {
  it.each<{ name: string; body: unknown; expected: string | null }>([
    { name: 'absent fields', body: {}, expected: null },
    { name: 'null body', body: null, expected: null },
    { name: 'undefined body', body: undefined, expected: null },
    { name: 'primitive body', body: 'high', expected: null },
    { name: 'array body', body: [], expected: null },
    {
      name: 'enabled thinking',
      body: { thinking: { type: 'enabled' } },
      expected: 'thinking:enabled',
    },
    {
      name: 'adaptive thinking',
      body: { thinking: { type: 'adaptive' } },
      expected: 'thinking:adaptive',
    },
    {
      name: 'disabled thinking',
      body: { thinking: { type: 'disabled' } },
      expected: 'thinking:disabled',
    },
    ...[
      [0, 'le1k'],
      [1_000, 'le1k'],
      [1_001, 'le4k'],
      [4_000, 'le4k'],
      [4_001, 'le16k'],
      [16_000, 'le16k'],
      [16_001, 'le64k'],
      [32_000, 'le64k'],
      [64_000, 'le64k'],
      [64_001, 'gt64k'],
    ].flatMap(([budget, bucket]) => [
      {
        name: `thinking budget ${budget}`,
        body: { thinking: { type: 'enabled', budget_tokens: budget } },
        expected: `thinking:enabled:${bucket}`,
      },
      {
        name: `reasoning budget ${budget}`,
        body: { reasoning: { max_tokens: budget } },
        expected: `reasoning:budget:${bucket}`,
      },
    ]),
    ...['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].flatMap(effort => [
      {
        name: `chat effort ${effort}`,
        body: { reasoning_effort: effort },
        expected: `effort:${effort}`,
      },
      {
        name: `messages effort ${effort}`,
        body: { output_config: { effort } },
        expected: `effort:${effort}`,
      },
      {
        name: `responses effort ${effort}`,
        body: { reasoning: { effort } },
        expected: `effort:${effort}`,
      },
    ]),
    ...['HIGH', '', 'unbounded-client-label'.repeat(100)].flatMap(effort => [
      { name: 'unknown chat effort', body: { reasoning_effort: effort }, expected: 'effort:other' },
      {
        name: 'unknown messages effort',
        body: { output_config: { effort } },
        expected: 'effort:other',
      },
      {
        name: 'unknown reasoning effort',
        body: { reasoning: { effort } },
        expected: 'effort:other',
      },
    ]),
    {
      name: 'reasoning disabled',
      body: { reasoning: { enabled: false } },
      expected: 'reasoning:disabled',
    },
    { name: 'reasoning exclude ignored', body: { reasoning: { exclude: true } }, expected: null },
    { name: 'reasoning enabled ignored', body: { reasoning: { enabled: true } }, expected: null },
    {
      name: 'fixed label order',
      body: {
        reasoning: { effort: 'high', enabled: false, max_tokens: 4_000, exclude: true },
        thinking: { type: 'adaptive', budget_tokens: 32_000 },
      },
      expected: 'thinking:adaptive:le64k+effort:high+reasoning:disabled+reasoning:budget:le4k',
    },
    {
      name: 'effort alias precedence',
      body: {
        output_config: { effort: 'low' },
        reasoning_effort: 'medium',
        reasoning: { effort: 'high' },
      },
      expected: 'effort:low',
    },
    ...[
      { thinking: { type: 'client-supplied', budget_tokens: 32_000 } },
      { thinking: 'enabled', reasoning: 'high', output_config: 'high' },
      { thinking: [], reasoning: [], output_config: [] },
      { thinking: null, reasoning: null, output_config: null },
      { thinking: { type: 123 }, reasoning: { enabled: 'false', max_tokens: '1000' } },
      { reasoning_effort: 123, output_config: { effort: {} }, reasoning: { effort: false } },
      { reasoning: { max_tokens: NaN } },
      { reasoning: { max_tokens: Infinity } },
    ].map(body => ({ name: 'malformed input', body, expected: null })),
    {
      name: 'malformed budget does not discard known thinking type',
      body: { thinking: { type: 'enabled', budget_tokens: '32000' } },
      expected: 'thinking:enabled',
    },
  ])('$name', ({ body, expected }) => {
    expect(extractReasoningSetting(body)).toBe(expected);
  });
});

describe('getOrganizationProviderPrivacy', () => {
  it.each(['allow', 'deny'] as const)('returns data_collection=%s', dataCollection => {
    expect(getOrganizationProviderPrivacy({ data_collection: dataCollection })).toEqual({
      data_collection: dataCollection,
    });
  });

  it('leaves Enterprise model and provider restrictions to the member decision', () => {
    expect(
      getOrganizationProviderPrivacy({
        provider_allow_list: ['openai', 'virtual'],
        model_deny_list: ['anthropic/claude-3-opus'],
        data_collection: 'deny',
      })
    ).toEqual({ data_collection: 'deny' });
  });

  it('returns no provider config without privacy settings', () => {
    expect(getOrganizationProviderPrivacy(undefined)).toBeUndefined();
    expect(getOrganizationProviderPrivacy({ provider_allow_list: ['openai'] })).toBeUndefined();
  });
});

describe('extractEmbeddingPromptInfo', () => {
  it('should extract prefix from a single string input', () => {
    const result = extractEmbeddingPromptInfo({ input: 'Hello world' });

    expect(result.user_prompt_prefix).toBe('Hello world');
    expect(result.system_prompt_prefix).toBe('');
    expect(result.system_prompt_length).toBe(0);
  });

  it('should extract the first element from a string array input', () => {
    const result = extractEmbeddingPromptInfo({ input: ['First sentence', 'Second sentence'] });

    expect(result.user_prompt_prefix).toBe('First sentence');
  });

  it('should fall back to JSON.stringify for an empty array', () => {
    const result = extractEmbeddingPromptInfo({ input: [] });

    expect(result.user_prompt_prefix).toBe('[]');
  });

  it('should fall back to JSON.stringify for a number array (token input)', () => {
    const result = extractEmbeddingPromptInfo({ input: [1, 2, 3] });

    expect(result.user_prompt_prefix).toBe('[1,2,3]');
  });

  it('should fall back to JSON.stringify for a nested number array (token batch)', () => {
    const result = extractEmbeddingPromptInfo({
      input: [
        [1, 2],
        [3, 4],
      ],
    });

    expect(result.user_prompt_prefix).toBe('[[1,2],[3,4]]');
  });

  it('should truncate long string input to 100 characters', () => {
    const longInput = 'x'.repeat(200);
    const result = extractEmbeddingPromptInfo({ input: longInput });

    expect(result.user_prompt_prefix).toHaveLength(100);
    expect(result.user_prompt_prefix).toBe('x'.repeat(100));
  });

  it('should truncate long first element of string array to 100 characters', () => {
    const longInput = 'y'.repeat(200);
    const result = extractEmbeddingPromptInfo({ input: [longInput] });

    expect(result.user_prompt_prefix).toHaveLength(100);
  });

  it('should always return empty system_prompt_prefix and zero system_prompt_length', () => {
    const result = extractEmbeddingPromptInfo({ input: 'any input' });

    expect(result.system_prompt_prefix).toBe('');
    expect(result.system_prompt_length).toBe(0);
  });
});

describe('extractEditPromptInfo', () => {
  it('uses zero system prompt length because edit has no explicit system prompt', () => {
    const result = extractEditPromptInfo({
      messages: [{ role: 'user', content: '<|code_to_edit|>const a = 1<|/code_to_edit|>' }],
    });

    expect(result.system_prompt_prefix).toBe('');
    expect(result.system_prompt_length).toBe(0);
    expect(result.user_prompt_prefix).toBe('<|code_to_edit|>const a = 1<|/code_to_edit|>');
  });
});

describe('parseEditUsageFromResponse', () => {
  it('prices cached Inception input tokens at the discounted rate', () => {
    const result = parseEditUsageFromResponse(
      JSON.stringify({
        id: 'edit-123',
        model: 'mercury-edit-2',
        usage: {
          prompt_tokens: 100_000,
          cached_input_tokens: 90_000,
          completion_tokens: 0,
          total_tokens: 100_000,
        },
        choices: [],
      }),
      'inception',
      200
    );

    expect(result.inputTokens).toBe(100_000);
    expect(result.cacheHitTokens).toBe(90_000);
    expect(result.cost_mUsd).toBe(4_750);
    expect(result.cacheDiscount_mUsd).toBe(20_250);
  });

  it('falls back to flat Inception pricing when cached_input_tokens is absent', () => {
    const result = parseEditUsageFromResponse(
      JSON.stringify({
        id: 'edit-456',
        model: 'mercury-edit-2',
        usage: {
          prompt_tokens: 1_000,
          completion_tokens: 100,
          total_tokens: 1_100,
        },
        choices: [{ message: { role: 'assistant', content: 'edited' } }],
      }),
      'inception',
      200
    );

    expect(result.cacheHitTokens).toBe(0);
    expect(result.cost_mUsd).toBe(Math.round(1_000 * 0.25 + 100 * 0.75));
    expect(result.cacheDiscount_mUsd).toBe(0);
    expect(result.hasError).toBe(false);
  });

  it('returns zero cost when usage is absent', () => {
    const result = parseEditUsageFromResponse(
      JSON.stringify({
        id: 'edit-789',
        model: 'mercury-edit-2',
        choices: [],
      }),
      'inception',
      200
    );

    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.cacheHitTokens).toBe(0);
    expect(result.cost_mUsd).toBe(0);
    expect(result.cacheDiscount_mUsd).toBeUndefined();
  });

  it('flags an error and zero cost on upstream 4xx responses', () => {
    const result = parseEditUsageFromResponse(
      JSON.stringify({ error: { message: 'bad request' } }),
      'inception',
      400
    );

    expect(result.hasError).toBe(true);
    expect(result.cost_mUsd).toBe(0);
    expect(result.model).toBeNull();
  });

  it('clamps cached_input_tokens that exceed prompt_tokens', () => {
    const result = parseEditUsageFromResponse(
      JSON.stringify({
        id: 'edit-clamp',
        model: 'mercury-edit-2',
        usage: {
          prompt_tokens: 1_000,
          cached_input_tokens: 5_000,
          completion_tokens: 0,
          total_tokens: 1_000,
        },
        choices: [],
      }),
      'inception',
      200
    );

    // Without the clamp, uncachedInputTokens would be negative and produce a
    // negative cost. The clamp pins cacheHitTokens at prompt_tokens.
    expect(result.cacheHitTokens).toBe(1_000);
    expect(result.cost_mUsd).toBe(25);
  });
});

describe('countAndStoreEmbeddingUsage', () => {
  beforeEach(() => {
    mockedLogMicrodollarUsage.mockClear();
  });

  it.each([
    { is_free: false, user_byok: false, expectedCost: 1000 },
    { is_free: true, user_byok: false, expectedCost: 0 },
    { is_free: false, user_byok: true, expectedCost: 0 },
  ])('uses the free/BYOK snapshots for embedding cost: %j', async testCase => {
    const usageContext: MicrodollarUsageContext = {
      ...createMockUsageContext('user-id', 'embedding@example.com', 0),
      api_kind: 'embeddings',
      requested_model: 'test/embedding',
      is_free: testCase.is_free,
      user_byok: testCase.user_byok,
    };
    const response = new Response(
      JSON.stringify({
        id: 'embedding-id',
        model: 'test/embedding',
        usage: { prompt_tokens: 10, cost: 0.001 },
      })
    );

    countAndStoreEmbeddingUsage(response, usageContext, undefined);
    await new Promise(resolve => setImmediate(resolve));

    expect(mockedLogMicrodollarUsage).toHaveBeenCalledWith(
      expect.objectContaining({ cost_mUsd: testCase.expectedCost, market_cost: 1000 }),
      usageContext
    );
  });
});

describe('countAndStoreFimUsage', () => {
  function makeUsageContext(
    overrides: Partial<MicrodollarUsageContext> = {}
  ): MicrodollarUsageContext {
    return {
      api_kind: 'fim_completions',
      kiloUserId: 'user-fim-test',
      provider: 'inception',
      requested_model: 'inception/mercury-edit-2',
      promptInfo: {
        system_prompt_prefix: '',
        system_prompt_length: 0,
        user_prompt_prefix: '',
      },
      max_tokens: 100,
      has_middle_out_transform: null,
      fraudHeaders: {},
      isStreaming: false,
      organizationId: undefined,
      prior_microdollar_usage: 0,
      posthog_distinct_id: undefined,
      project_id: null,
      status_code: 200,
      editor_name: null,
      machine_id: null,
      user_byok: false,
      is_free: false,
      has_tools: false,
      feature: null,
      session_id: null,
      mode: null,
      auto_model: null,
      reasoning_setting: null,
      ttfb_ms: null,
      ...overrides,
    } as MicrodollarUsageContext;
  }

  function makeUpstreamResponse(): Response {
    return new Response(
      JSON.stringify({
        id: 'fim-test',
        model: 'mercury-edit-2',
        usage: {
          prompt_tokens: 1_000,
          completion_tokens: 100,
          total_tokens: 1_100,
        },
        choices: [{ text: 'completion' }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }

  beforeEach(() => {
    mockedLogMicrodollarUsage.mockClear();
    mockedLogMicrodollarUsage.mockResolvedValue(null);
  });

  it('bills the Inception model', async () => {
    countAndStoreFimUsage(makeUpstreamResponse(), makeUsageContext(), undefined);

    await new Promise(resolve => setImmediate(resolve));

    const [stats] = mockedLogMicrodollarUsage.mock.calls[0];
    expect(stats.cost_mUsd).toBe(325);
    expect(stats.market_cost).toBe(325);
  });

  it('bills other FIM models', async () => {
    countAndStoreFimUsage(
      makeUpstreamResponse(),
      makeUsageContext({
        provider: 'mistral',
        requested_model: 'mistralai/codestral-2508',
      }),
      undefined
    );

    await new Promise(resolve => setImmediate(resolve));

    const [stats] = mockedLogMicrodollarUsage.mock.calls[0];
    expect(stats.cost_mUsd).toBe(390);
    expect(stats.market_cost).toBe(390);
  });

  it.each([
    { user_byok: true, is_free: false },
    { user_byok: false, is_free: true },
  ])('does not bill BYOK or free requests: %j', async overrides => {
    countAndStoreFimUsage(makeUpstreamResponse(), makeUsageContext(overrides), undefined);

    await new Promise(resolve => setImmediate(resolve));

    const [stats] = mockedLogMicrodollarUsage.mock.calls[0];
    expect(stats.cost_mUsd).toBe(0);
    expect(stats.cacheDiscount_mUsd).toBe(0);
    expect(stats.market_cost).toBe(325);
  });
});

describe('countAndStoreEditUsage', () => {
  function makeUsageContext(
    overrides: Partial<MicrodollarUsageContext> = {}
  ): MicrodollarUsageContext {
    return {
      api_kind: 'edit_completions',
      kiloUserId: 'user-edit-test',
      provider: 'inception',
      requested_model: 'inception/mercury-edit-2',
      promptInfo: {
        system_prompt_prefix: '',
        system_prompt_length: 0,
        user_prompt_prefix: '',
      },
      max_tokens: 100,
      has_middle_out_transform: null,
      fraudHeaders: {},
      isStreaming: false,
      organizationId: undefined,
      prior_microdollar_usage: 0,
      posthog_distinct_id: undefined,
      project_id: null,
      status_code: 200,
      editor_name: null,
      machine_id: null,
      user_byok: false,
      is_free: false,
      has_tools: false,
      feature: null,
      session_id: null,
      mode: null,
      auto_model: null,
      reasoning_setting: null,
      ttfb_ms: null,
      ...overrides,
    } as MicrodollarUsageContext;
  }

  function makeUpstreamResponse(payload: unknown): Response {
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  beforeEach(() => {
    mockedLogMicrodollarUsage.mockClear();
    mockedLogMicrodollarUsage.mockResolvedValue(null);
  });

  it.each([
    { user_byok: true, is_free: false },
    { user_byok: false, is_free: true },
  ])('zeros costs for BYOK or free requests: %j', async overrides => {
    const response = makeUpstreamResponse({
      id: 'edit-byok',
      model: 'mercury-edit-2',
      usage: {
        prompt_tokens: 100_000,
        cached_input_tokens: 90_000,
        completion_tokens: 0,
        total_tokens: 100_000,
      },
      choices: [],
    });

    countAndStoreEditUsage(response, makeUsageContext(overrides), undefined);

    // Allow the async usage parse + after() callback to settle.
    await new Promise(resolve => setImmediate(resolve));

    expect(mockedLogMicrodollarUsage).toHaveBeenCalledTimes(1);
    const [stats] = mockedLogMicrodollarUsage.mock.calls[0];
    expect(stats.cost_mUsd).toBe(0);
    expect(stats.cacheDiscount_mUsd).toBe(0);
    // The pre-zeroed value is preserved in `market_cost` for reporting.
    expect(stats.market_cost).toBe(4_750);
  });

  it('bills non-BYOK requests', async () => {
    const response = makeUpstreamResponse({
      id: 'edit-paid',
      model: 'mercury-edit-2',
      usage: {
        prompt_tokens: 100_000,
        cached_input_tokens: 90_000,
        completion_tokens: 0,
        total_tokens: 100_000,
      },
      choices: [],
    });

    countAndStoreEditUsage(response, makeUsageContext({ user_byok: false }), undefined);

    await new Promise(resolve => setImmediate(resolve));

    expect(mockedLogMicrodollarUsage).toHaveBeenCalledTimes(1);
    const [stats] = mockedLogMicrodollarUsage.mock.calls[0];
    expect(stats.cost_mUsd).toBe(4_750);
    expect(stats.cacheDiscount_mUsd).toBe(20_250);
    expect(stats.market_cost).toBe(4_750);
  });

  it('does not log usage when the upstream body is missing', async () => {
    const bodylessResponse = new Response(null, { status: 502 });

    countAndStoreEditUsage(bodylessResponse, makeUsageContext({ status_code: 502 }), undefined);

    await new Promise(resolve => setImmediate(resolve));

    expect(mockedLogMicrodollarUsage).not.toHaveBeenCalled();
  });
});

describe('parseEmbeddingUsageFromResponse', () => {
  function makeResponse(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      id: 'embd-123',
      object: 'list',
      model: 'text-embedding-3-small',
      usage: { prompt_tokens: 100, total_tokens: 100 },
      data: [{ object: 'embedding', embedding: [0.1, 0.2], index: 0 }],
      ...overrides,
    });
  }

  it('should use upstream cost field when available', () => {
    const response = makeResponse({
      usage: { prompt_tokens: 100, total_tokens: 100, cost: 0.00005 },
    });

    const result = parseEmbeddingUsageFromResponse(response, 200);

    expect(result.cost_mUsd).toBe(50);
  });

  it('should default to 0 cost when upstream cost field is absent', () => {
    const response = makeResponse({
      usage: { prompt_tokens: 1000, total_tokens: 1000 },
    });

    const result = parseEmbeddingUsageFromResponse(response, 200);

    expect(result.cost_mUsd).toBe(0);
  });

  it('should extract id as messageId', () => {
    const response = makeResponse({ id: 'embd-abc' });

    const result = parseEmbeddingUsageFromResponse(response, 200);

    expect(result.messageId).toBe('embd-abc');
  });

  it('should set messageId to null when id is absent', () => {
    const response = makeResponse({});
    const parsed = JSON.parse(response);
    delete parsed.id;

    const result = parseEmbeddingUsageFromResponse(JSON.stringify(parsed), 200);

    expect(result.messageId).toBeNull();
  });

  it('should set hasError to true when model is empty', () => {
    const response = makeResponse({ model: '' });

    const result = parseEmbeddingUsageFromResponse(response, 200);

    expect(result.hasError).toBe(true);
  });

  it('should set hasError to false when model is present', () => {
    const response = makeResponse({ model: 'text-embedding-3-small' });

    const result = parseEmbeddingUsageFromResponse(response, 200);

    expect(result.hasError).toBe(false);
  });

  it('should always set outputTokens to 0 and streamed/cancelled to false', () => {
    const response = makeResponse();

    const result = parseEmbeddingUsageFromResponse(response, 200);

    expect(result.outputTokens).toBe(0);
    expect(result.streamed).toBe(false);
    expect(result.cancelled).toBe(false);
  });

  it('should extract prompt_tokens as inputTokens', () => {
    const response = makeResponse({
      usage: { prompt_tokens: 42, total_tokens: 42 },
    });

    const result = parseEmbeddingUsageFromResponse(response, 200);

    expect(result.inputTokens).toBe(42);
  });
});

describe('parseTranscriptionUsageFromResponse', () => {
  function makeResponse(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      id: 'stt-123',
      model: 'openai/gpt-4o-mini-transcribe',
      text: 'hello world',
      usage: {
        seconds: 2.5,
        input_tokens: 10,
        output_tokens: 4,
        total_tokens: 14,
        cost: 0.00002,
        is_byok: false,
      },
      ...overrides,
    });
  }

  it('uses upstream cost and token fields', () => {
    const result = parseTranscriptionUsageFromResponse(
      makeResponse(),
      200,
      'openai/gpt-4o-mini-transcribe'
    );

    expect(result.cost_mUsd).toBe(20);
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(4);
  });

  it('uses BYOK upstream inference cost when present', () => {
    const result = parseTranscriptionUsageFromResponse(
      makeResponse({
        usage: {
          seconds: 2.5,
          input_tokens: 10,
          output_tokens: 4,
          total_tokens: 14,
          cost: 0,
          is_byok: true,
          cost_details: { upstream_inference_cost: 0.00004 },
        },
      }),
      200,
      'openai/gpt-4o-mini-transcribe'
    );

    expect(result.cost_mUsd).toBe(40);
    expect(result.is_byok).toBe(true);
  });

  it('stores duration as generation time', () => {
    const result = parseTranscriptionUsageFromResponse(
      makeResponse(),
      200,
      'openai/gpt-4o-mini-transcribe'
    );

    expect(result.generation_time).toBe(2.5);
  });

  it('falls back to requested model when response model is absent', () => {
    const parsed = JSON.parse(makeResponse());
    delete parsed.model;

    const result = parseTranscriptionUsageFromResponse(
      JSON.stringify(parsed),
      200,
      'openai/whisper-1'
    );

    expect(result.model).toBe('openai/whisper-1');
  });

  it('marks non-text responses as errors', () => {
    const parsed = JSON.parse(makeResponse());
    delete parsed.text;

    const result = parseTranscriptionUsageFromResponse(
      JSON.stringify(parsed),
      200,
      'openai/gpt-4o-mini-transcribe'
    );

    expect(result.hasError).toBe(true);
  });
});

describe('captureProxyError', () => {
  beforeEach(() => {
    mockedErrorExceptInTest.mockClear();
  });

  async function capturedErrorData() {
    for (
      let attempt = 0;
      attempt < 20 && mockedErrorExceptInTest.mock.calls.length === 0;
      attempt++
    ) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    expect(mockedErrorExceptInTest).toHaveBeenCalledTimes(1);
    return mockedErrorExceptInTest.mock.calls[0][1] as Record<string, unknown>;
  }

  it('logs the gateway model, BYOK providers, and request field names', async () => {
    await captureProxyError({
      errorMessage: 'direct-byok returned error 400',
      user: { id: 'user-1' },
      request: {
        model: 'glm-5.3-flash',
        reasoning: { effort: 'high' },
        messages: [
          { role: 'user', content: 'secret prompt' },
          { role: 'assistant', content: 'hi', reasoning: 'secret thoughts' },
        ],
      },
      response: new Response('{"error":"unknown field"}', {
        status: 400,
        statusText: 'Bad Request',
        headers: { 'content-type': 'application/json' },
      }),
      organizationId: undefined,
      model: 'glm-5.3-flash',
      gatewayModel: 'opencode-go/glm-5.3-flash',
      byokProviderIds: ['opencode-go'],
      trackInSentry: false,
    });

    const data = await capturedErrorData();
    expect(data).toMatchObject({
      model: 'glm-5.3-flash',
      gatewayModel: 'opencode-go/glm-5.3-flash',
      byokProviderIds: 'opencode-go',
      requestFields: 'messages,model,reasoning',
      messageFields: 'content,reasoning,role',
      first4kOfResponse: '{"error":"unknown field"}',
    });
    expect(JSON.stringify(data)).not.toContain('secret');
  });

  it('omits optional fields that add no information', async () => {
    await captureProxyError({
      errorMessage: 'openrouter returned error 400',
      user: { id: 'user-1' },
      request: null,
      response: new Response('', { status: 400 }),
      organizationId: undefined,
      model: 'vendor/model',
      gatewayModel: 'vendor/model',
      byokProviderIds: null,
      trackInSentry: false,
    });

    const data = await capturedErrorData();
    expect(data).not.toHaveProperty('gatewayModel');
    expect(data).not.toHaveProperty('byokProviderIds');
    expect(data).not.toHaveProperty('requestFields');
    expect(data).not.toHaveProperty('messageFields');
  });
});

describe('makeErrorReadable', () => {
  const request = {
    kind: 'chat_completions',
    body: { model: 'test', messages: [], stream: false },
  } satisfies GatewayRequest;

  it('returns undefined for non-error responses', async () => {
    const response = new Response('{}', { status: 200 });
    const result = await makeErrorReadable({
      providerId: 'openrouter',
      requestedModel: 'anything',
      request,
      response,
      userByokProviderIds: null,
    });
    expect(result).toBeUndefined();
  });

  it('explains a missing model for a Vertex user BYOK request', async () => {
    const response = Response.json({ error: { message: 'AI_APICallError' } }, { status: 404 });

    const result = await makeErrorReadable({
      providerId: 'vercel',
      requestedModel: 'anthropic/claude-sonnet-5',
      request,
      response,
      userByokProviderIds: ['vertex'],
    });

    expect(result?.status).toBe(404);
    await expect(result?.json()).resolves.toEqual({
      error:
        '[BYOK] Google Vertex AI could not find the requested model. The model might not be enabled for your Google Cloud project or selected Vertex location.',
      error_type: 'byok_error',
      message:
        '[BYOK] Google Vertex AI could not find the requested model. The model might not be enabled for your Google Cloud project or selected Vertex location.',
    });
  });

  it('does not label other user BYOK 404 responses as Vertex errors', async () => {
    const response = Response.json({ error: { message: 'Model not found' } }, { status: 404 });

    const result = await makeErrorReadable({
      providerId: 'vercel',
      requestedModel: 'anthropic/claude-sonnet-5',
      request,
      response,
      userByokProviderIds: ['anthropic'],
    });

    expect(result?.status).toBe(404);
    await expect(result?.json()).resolves.toEqual({
      error: '[BYOK] Model not found',
      error_type: 'byok_error',
      message: '[BYOK] Model not found',
    });
  });

  it.each([
    {
      providerId: 'direct-byok',
      userByokProviderIds: ['opencode-go'],
      body: {
        error: { type: 'server_error', message: 'A synthetic region setting blocks this model.' },
      },
      expectedMessage: 'A synthetic region setting blocks this model.',
    },
    {
      providerId: 'vercel',
      userByokProviderIds: ['anthropic'],
      body: {
        error: {
          message: 'Synthetic provider account configuration needs attention.',
          metadata: { routing: { credentialType: 'byok' } },
        },
        isRetryable: false,
      },
      expectedMessage: 'Synthetic provider account configuration needs attention.',
    },
    {
      providerId: 'vercel',
      userByokProviderIds: [],
      body: { message: 'Synthetic request option is unsupported.' },
      expectedMessage: 'Synthetic request option is unsupported.',
    },
  ] as const)(
    'marks a $providerId BYOK 400 without forwarding upstream metadata',
    async fixture => {
      const result = await makeErrorReadable({
        providerId: fixture.providerId,
        requestedModel: 'synthetic-model',
        request,
        response: Response.json(fixture.body, { status: 400 }),
        userByokProviderIds: [...fixture.userByokProviderIds],
      });

      expect(result?.status).toBe(400);
      await expect(result?.json()).resolves.toEqual({
        error: `[BYOK] ${fixture.expectedMessage}`,
        error_type: 'byok_error',
        message: `[BYOK] ${fixture.expectedMessage}`,
      });
    }
  );

  it.each([400, 404, 405, 408, 409, 422, 499])(
    'preserves the upstream status for a generic BYOK %i',
    async status => {
      const result = await makeErrorReadable({
        providerId: 'vercel',
        requestedModel: 'synthetic-model',
        request,
        response: Response.json({}, { status }),
        userByokProviderIds: [],
      });

      expect(result?.status).toBe(status);
      await expect(result?.json()).resolves.toEqual({
        error:
          '[BYOK] Your provider rejected the request. Check your provider account and settings.',
        error_type: 'byok_error',
        message:
          '[BYOK] Your provider rejected the request. Check your provider account and settings.',
      });
    }
  );

  it('keeps context overflow ahead of generic BYOK rejection', async () => {
    const body = {
      error: { message: 'The maximum context length is 1024 tokens. Requested 2048 tokens.' },
    };
    const result = await makeErrorReadable({
      providerId: 'direct-byok',
      requestedModel: 'synthetic-model',
      request,
      response: Response.json(body, { status: 400 }),
      userByokProviderIds: ['opencode-go'],
    });

    expect(result?.status).toBe(400);
    await expect(result?.json()).resolves.toEqual({
      ...body,
      error_type: 'context_length_exceeded',
    });
  });

  it.each([
    [401, []],
    [402, ['anthropic']],
    [403, ['anthropic']],
    [403, ['opencode-go']],
    [429, []],
    [404, ['vertex']],
  ] as const)(
    'keeps the specific BYOK %i mapping ahead of an upstream overflow body for %j',
    async (status, providerIds) => {
      const options = {
        providerId: 'vercel',
        requestedModel: 'synthetic-model',
        request,
        userByokProviderIds: [...providerIds],
      } satisfies Omit<Parameters<typeof makeErrorReadable>[0], 'response'>;
      const baseline = await makeErrorReadable({
        ...options,
        response: Response.json({}, { status }),
      });
      const result = await makeErrorReadable({
        ...options,
        response: Response.json(
          {
            error: { message: 'The maximum context length is 1024 tokens. Requested 2048 tokens.' },
          },
          { status }
        ),
      });

      expect(result?.status).toBe(status);
      const body = await result?.json();
      const baselineBody = await baseline?.json();
      expect(body).toMatchObject({ error_type: 'byok_error' });
      expect(body.message.startsWith(baselineBody.message)).toBe(true);
    }
  );

  it('appends the provider explanation to a specific BYOK 401 message', async () => {
    const result = await makeErrorReadable({
      providerId: 'direct-byok',
      requestedModel: 'opencode-go/glm-5.3-flash',
      request,
      response: Response.json(
        {
          error: {
            type: 'authentication_error',
            code: 'api_key_expired',
            message:
              'This API key has expired. Create a new API key in OpenCode Console and replace it in your client or secret store.',
          },
        },
        { status: 401 }
      ),
      userByokProviderIds: ['opencode-go'],
    });

    const expected =
      '[BYOK] Your API key is invalid or has been revoked. Please check your API key configuration. Provider message: This API key has expired. Create a new API key in OpenCode Console and replace it in your client or secret store.';
    expect(result?.status).toBe(401);
    await expect(result?.json()).resolves.toEqual({
      error: expected,
      error_type: 'byok_error',
      message: expected,
    });
  });

  it('appends the provider explanation to the OpenCode Go BYOK permission message', async () => {
    const result = await makeErrorReadable({
      providerId: 'direct-byok',
      requestedModel: 'opencode-go/mimo-v2.5',
      request,
      response: Response.json(
        { message: 'Synthetic data collection opt-in required.' },
        { status: 403 }
      ),
      userByokProviderIds: ['opencode-go'],
    });

    const expected =
      '[BYOK] Your API key does not have permission to access this model. Some OpenCode Go models require opting in to data collection or region-specific inference in OpenCode Go. Provider message: Synthetic data collection opt-in required.';
    await expect(result?.json()).resolves.toEqual({
      error: expected,
      error_type: 'byok_error',
      message: expected,
    });
  });

  it('removes control characters and bounds provider text appended to a specific BYOK message', async () => {
    const result = await makeErrorReadable({
      providerId: 'vercel',
      requestedModel: 'synthetic-model',
      request,
      response: Response.json(
        { error: { message: `  Synthetic\u0000\n${'x'.repeat(400)}  ` } },
        { status: 429 }
      ),
      userByokProviderIds: ['anthropic'],
    });

    const expected = `[BYOK] Your API key has hit its rate limit. Please try again later or check your rate limit settings with your API provider. Provider message: ${`Synthetic  ${'x'.repeat(400)}`.slice(0, 300)}`;
    await expect(result?.json()).resolves.toEqual({
      error: expected,
      error_type: 'byok_error',
      message: expected,
    });
  });

  it.each([400, 500, 502, 503])(
    'leaves non-BYOK errors and BYOK outages unchanged for status %i',
    async status => {
      for (const userByokProviderIds of status === 400 ? [null] : [null, ['anthropic'] as const]) {
        await expect(
          makeErrorReadable({
            providerId: 'vercel',
            requestedModel: 'synthetic-model',
            request,
            response: Response.json(
              { error: { message: 'Synthetic provider failure.' } },
              { status }
            ),
            userByokProviderIds: userByokProviderIds === null ? null : [...userByokProviderIds],
          })
        ).resolves.toBeUndefined();
      }
    }
  );

  it('removes control characters and bounds generic BYOK provider text', async () => {
    const result = await makeErrorReadable({
      providerId: 'vercel',
      requestedModel: 'synthetic-model',
      request,
      response: Response.json(
        { error: { message: `  Synthetic\u0000\n\u007f\u0085${'x'.repeat(400)}  ` } },
        { status: 400 }
      ),
      userByokProviderIds: ['anthropic'],
    });

    const expected = `[BYOK] ${`Synthetic    ${'x'.repeat(400)}`.slice(0, 300)}`;
    await expect(result?.json()).resolves.toEqual({
      error: expected,
      error_type: 'byok_error',
      message: expected,
    });
  });

  it.each(['not json', '{}', '{"error":{"message":42}}', '{"message":"\\u0000\\n"}'])(
    'falls back to fixed BYOK text for an unusable provider body: %s',
    async body => {
      const result = await makeErrorReadable({
        providerId: 'vercel',
        requestedModel: 'synthetic-model',
        request,
        response: new Response(body, { status: 400 }),
        userByokProviderIds: ['anthropic'],
      });

      await expect(result?.json()).resolves.toEqual({
        error:
          '[BYOK] Your provider rejected the request. Check your provider account and settings.',
        error_type: 'byok_error',
        message:
          '[BYOK] Your provider rejected the request. Check your provider account and settings.',
      });
    }
  );

  it.each([
    [401, []],
    [402, ['anthropic']],
    [403, []],
    [429, ['anthropic']],
  ] as const)('treats a non-null provider set as user BYOK for status %i', async (status, ids) => {
    const result = await makeErrorReadable({
      providerId: 'vercel',
      requestedModel: 'anthropic/claude-sonnet-5',
      request,
      response: Response.json({}, { status }),
      userByokProviderIds: [...ids],
    });

    expect(result).toBeDefined();
    if (!result) throw new Error('Expected a readable BYOK error response');
    expect((await result.json()).error_type).toBe('byok_error');
  });

  it('names the model in a generic BYOK permission error', async () => {
    const result = await makeErrorReadable({
      providerId: 'vercel',
      requestedModel: 'anthropic/claude-sonnet-5',
      request,
      response: Response.json({}, { status: 403 }),
      userByokProviderIds: ['anthropic'],
    });

    await expect(result?.json()).resolves.toEqual({
      error:
        '[BYOK] Your API key does not have permission to access this model. Please check your API key permissions.',
      error_type: 'byok_error',
      message:
        '[BYOK] Your API key does not have permission to access this model. Please check your API key permissions.',
    });
  });

  it('mentions OpenCode Go opt-in requirements on a BYOK permission error', async () => {
    const result = await makeErrorReadable({
      providerId: 'direct-byok',
      requestedModel: 'opencode-go/mimo-v2.5',
      request,
      response: Response.json({ model: 'mimo-v2.5' }, { status: 403 }),
      userByokProviderIds: ['opencode-go'],
    });

    await expect(result?.json()).resolves.toEqual({
      error:
        '[BYOK] Your API key does not have permission to access this model. Some OpenCode Go models require opting in to data collection or region-specific inference in OpenCode Go.',
      error_type: 'byok_error',
      message:
        '[BYOK] Your API key does not have permission to access this model. Some OpenCode Go models require opting in to data collection or region-specific inference in OpenCode Go.',
    });
  });

  it('does not use generic BYOK errors for a null provider set', async () => {
    await expect(
      makeErrorReadable({
        providerId: 'vercel',
        requestedModel: 'anthropic/claude-sonnet-5',
        request,
        response: Response.json({}, { status: 401 }),
        userByokProviderIds: null,
      })
    ).resolves.toBeUndefined();
  });

  it.each([null, ['anthropic']] as const)(
    'keeps provider routing errors ahead of generic BYOK rejection with provider set %j',
    async providerIds => {
      const response = Response.json(
        {
          message: 'No allowed providers are available for the selected model.',
          code: 404,
          metadata: {
            available_providers: ['alibaba'],
            requested_providers: ['anthropic', 'openai'],
          },
        },
        { status: 404 }
      );

      const result = await makeErrorReadable({
        providerId: 'openrouter',
        requestedModel: 'qwen/qwen3.7-plus',
        request,
        response,
        userByokProviderIds: providerIds === null ? null : [...providerIds],
      });

      expect(result?.status).toBe(404);
      await expect(result?.json()).resolves.toEqual({
        error: 'No eligible provider can serve the selected model.',
        error_type: 'provider_not_allowed',
        message:
          'No eligible provider can serve the selected model. Select another model or update the provider routing settings.',
      });
    }
  );

  it('recognizes the wrapped OpenRouter error response', async () => {
    const response = Response.json(
      {
        error: {
          message: 'No allowed providers are available for the selected model.',
          code: 404,
          metadata: {
            available_providers: ['alibaba'],
            requested_providers: ['openai'],
          },
        },
      },
      { status: 404 }
    );

    const result = await makeErrorReadable({
      providerId: 'openrouter',
      requestedModel: 'qwen/qwen3.7-plus',
      request,
      response,
      userByokProviderIds: null,
    });

    expect(result).toBeDefined();
    if (!result) throw new Error('Expected a readable provider error response');
    expect(result.status).toBe(404);
    expect((await result.json()).error_type).toBe('provider_not_allowed');
  });

  it('does not rewrite matching errors from other providers', async () => {
    const response = Response.json(
      {
        message: 'No allowed providers are available for the selected model.',
        code: 404,
        metadata: {
          available_providers: ['alibaba'],
          requested_providers: ['openai'],
        },
      },
      { status: 404 }
    );

    await expect(
      makeErrorReadable({
        providerId: 'vercel',
        requestedModel: 'anything',
        request,
        response,
        userByokProviderIds: null,
      })
    ).resolves.toBeUndefined();
  });

  it('leaves unrelated and malformed upstream errors unchanged', async () => {
    const responses = [
      Response.json(
        {
          message: 'No allowed providers are available for the selected model.',
          code: 404,
          metadata: { available_providers: ['alibaba'] },
        },
        { status: 404 }
      ),
      Response.json({ message: 'Model not found', code: 404 }, { status: 404 }),
      new Response('not json', { status: 404 }),
    ];

    for (const response of responses) {
      await expect(
        makeErrorReadable({
          providerId: 'openrouter',
          requestedModel: 'anything',
          request,
          response,
          userByokProviderIds: null,
        })
      ).resolves.toBeUndefined();
    }
  });

  it('does not redact errors for custom model provider', async () => {
    const response = Response.json(
      { error: { message: 'Custom endpoint failure details' } },
      { status: 500 }
    );

    const result = await makeErrorReadable({
      providerId: 'custom',
      requestedModel: 'kilo-internal/custom-endpoint',
      request,
      response,
      userByokProviderIds: null,
    });

    expect(result).toBeUndefined();
  });

  it('redacts errors for stealth models', async () => {
    const response = Response.json(
      { error: { message: 'Upstream vendor secret error' } },
      { status: 502 }
    );

    const result = await makeErrorReadable({
      providerId: 'openrouter',
      requestedModel: 'stealth/claude-opus-4.7',
      request,
      response,
      userByokProviderIds: null,
    });

    expect(result).toBeDefined();
    expect(result?.status).toBe(502);
    await expect(result?.json()).resolves.toEqual({
      error: 'The upstream provider was unable to process the request',
      error_type: 'upstream_error',
      message: 'The upstream provider was unable to process the request',
    });
  });
});

describe('extractHeaderAndLimitLength', () => {
  // The auto-routing mirror contract relies on this helper never returning
  // an empty or whitespace-only string: MirrorPayloadSchema rejects the
  // whole payload on `.min(1)` identity fields, so '' must coerce to null.
  it('returns null for missing, empty, and whitespace-only headers', () => {
    const request = new Request('http://localhost', {
      headers: { 'x-empty': '', 'x-blank': '   ', 'x-padded': '  value  ' },
    }) as unknown as Parameters<typeof extractHeaderAndLimitLength>[0];

    expect(extractHeaderAndLimitLength(request, 'x-missing')).toBeNull();
    expect(extractHeaderAndLimitLength(request, 'x-empty')).toBeNull();
    expect(extractHeaderAndLimitLength(request, 'x-blank')).toBeNull();
    expect(extractHeaderAndLimitLength(request, 'x-padded')).toBe('value');
  });

  it('caps header values at 500 characters before trimming', () => {
    const request = new Request('http://localhost', {
      headers: { 'x-long': 'a'.repeat(600) },
    }) as unknown as Parameters<typeof extractHeaderAndLimitLength>[0];

    expect(extractHeaderAndLimitLength(request, 'x-long')).toBe('a'.repeat(500));
  });
});
describe('lastUserPromptText', () => {
  it('returns the last user message of a chat request', () => {
    expect(
      lastUserPromptText({
        kind: 'chat_completions',
        body: {
          messages: [
            { role: 'system', content: 'be terse' },
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'ok' },
            { role: 'user', content: 'second' },
          ],
        },
      })
    ).toBe('second');
  });

  it('joins the text parts of array content and ignores non-text parts', () => {
    expect(
      lastUserPromptText({
        kind: 'chat_completions',
        body: {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'look at this' },
                { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
                { type: 'text', text: 'and this' },
              ],
            },
          ],
        },
      })
    ).toBe('look at this\nand this');
  });

  it('reads a responses input string', () => {
    expect(lastUserPromptText({ kind: 'responses', body: { input: 'plain prompt' } })).toBe(
      'plain prompt'
    );
  });

  it('reads the last user item of a responses input list, including input_text parts', () => {
    expect(
      lastUserPromptText({
        kind: 'responses',
        body: {
          input: [
            { role: 'user', content: [{ type: 'input_text', text: 'older' }] },
            { role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
            { role: 'user', content: [{ type: 'input_text', text: 'newest' }] },
          ],
        },
      })
    ).toBe('newest');
  });

  it('reads a FIM prompt', () => {
    expect(lastUserPromptText({ kind: 'fim_completions', body: { prompt: 'fn main() {' } })).toBe(
      'fn main() {'
    );
  });

  it('returns null when the request has no user turn', () => {
    expect(lastUserPromptText({ kind: 'chat_completions', body: { messages: [] } })).toBeNull();
    expect(lastUserPromptText({ kind: 'messages', body: {} })).toBeNull();
    expect(lastUserPromptText({ kind: 'responses', body: { input: 42 } })).toBeNull();
  });
});

describe('requestedLogprobs', () => {
  it('is true for logprobs, top_logprobs, or a non-empty logit_bias', () => {
    expect(requestedLogprobs({ logprobs: true })).toBe(true);
    expect(requestedLogprobs({ top_logprobs: 5 })).toBe(true);
    expect(requestedLogprobs({ logit_bias: { '50256': -100 } })).toBe(true);
  });

  it('is false when the request asked for none of them', () => {
    expect(requestedLogprobs({})).toBe(false);
    expect(requestedLogprobs({ logprobs: false, top_logprobs: null, logit_bias: {} })).toBe(false);
  });
});

describe('requestedSamples', () => {
  it('returns the n sampling parameter, or null when it is absent', () => {
    expect(requestedSamples({ n: 3 })).toBe(3);
    expect(requestedSamples({})).toBeNull();
    expect(requestedSamples({ n: null })).toBeNull();
  });
});

describe('checkExclusiveModelProviderAllowed', () => {
  const multiProviderModel: KiloExclusiveModel = {
    ...reflection_beam_free_model,
    public_id: 'test/multi-provider-exclusive',
    inference_providers: ['anthropic', 'amazon-bedrock'],
  };

  beforeEach(() => {
    kiloExclusiveModels.push(multiProviderModel);
  });

  afterEach(() => {
    kiloExclusiveModels.splice(kiloExclusiveModels.indexOf(multiProviderModel), 1);
  });

  it('allows non-exclusive models, missing provider config, and unrestricted exclusives', () => {
    expect(checkExclusiveModelProviderAllowed('vendor/model', { only: ['openai'] })).toBeNull();
    expect(
      checkExclusiveModelProviderAllowed(reflection_beam_free_model.public_id, undefined)
    ).toBeNull();
    expect(
      checkExclusiveModelProviderAllowed(gemma_4_26b_a4b_it_free_model.public_id, {
        only: ['openai'],
      })
    ).toBeNull();
  });

  it('allows a model when any of its inference providers is eligible', () => {
    expect(
      checkExclusiveModelProviderAllowed(multiProviderModel.public_id, {
        only: ['amazon-bedrock'],
      })
    ).toBeNull();
    expect(
      checkExclusiveModelProviderAllowed(multiProviderModel.public_id, { ignore: ['anthropic'] })
    ).toBeNull();
  });

  it('rejects a model when none of its inference providers is eligible', async () => {
    const onlyResult = checkExclusiveModelProviderAllowed(multiProviderModel.public_id, {
      only: ['openai'],
    });
    expect(onlyResult?.status).toBe(403);
    expect(await onlyResult?.json()).toMatchObject({
      error_type: 'provider_not_allowed',
      error:
        'No eligible provider can serve the selected model. Please enable provider: anthropic, amazon-bedrock',
    });

    const ignoreResult = checkExclusiveModelProviderAllowed(
      glyph_cluster_stealth_free_model.public_id,
      {
        ignore: ['stealth'],
      }
    );
    expect(ignoreResult?.status).toBe(403);
  });
});
