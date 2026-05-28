import { describe, it, expect, beforeEach } from '@jest/globals';
import type { MicrodollarUsageContext, MicrodollarUsageStats } from './processUsage.types';

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
// the final, post-zeroing `usageStats` to `logMicrodollarUsage`, so spying
// here lets us assert on the persisted billing shape directly.
const mockedLogMicrodollarUsage = jest.fn(
  async (_stats: MicrodollarUsageStats, _ctx: MicrodollarUsageContext) => null
);
jest.mock('./processUsage', () => ({
  ...(jest.requireActual('./processUsage') as Record<string, unknown>),
  logMicrodollarUsage: (stats: MicrodollarUsageStats, ctx: MicrodollarUsageContext) =>
    mockedLogMicrodollarUsage(stats, ctx),
}));

import {
  checkOrganizationModelRestrictions,
  countAndStoreEditUsage,
  extractEditPromptInfo,
  extractEmbeddingPromptInfo,
  makeErrorReadable,
  parseEmbeddingUsageFromResponse,
  parseEditUsageFromResponse,
  parseTranscriptionUsageFromResponse,
} from './llm-proxy-helpers';

describe('checkOrganizationModelRestrictions', () => {
  describe('enterprise plan - model deny list restrictions', () => {
    it('should allow model when it is not in the deny list on enterprise plan', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          model_deny_list: ['openai/gpt-4'],
        },
        organizationPlan: 'enterprise',
      });

      expect(result.error).toBeNull();
    });

    it('should block model when it is in the deny list on enterprise plan', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          model_deny_list: ['anthropic/claude-3-opus'],
        },
        organizationPlan: 'enterprise',
      });

      expect(result.error).not.toBeNull();
      expect(result.error?.status).toBe(404);
    });

    it('should allow any model when deny list is empty on enterprise plan', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          model_deny_list: [],
        },
        organizationPlan: 'enterprise',
      });

      expect(result.error).toBeNull();
    });

    it('should allow any model when deny list is undefined on enterprise plan', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {},
        organizationPlan: 'enterprise',
      });

      expect(result.error).toBeNull();
    });

    it('should block multiple denied models on enterprise plan', () => {
      const settings = {
        model_deny_list: ['anthropic/claude-3-opus', 'openai/gpt-3.5-turbo'],
      };

      expect(
        checkOrganizationModelRestrictions({
          modelId: 'anthropic/claude-3-opus',
          settings,
          organizationPlan: 'enterprise',
        }).error
      ).not.toBeNull();

      expect(
        checkOrganizationModelRestrictions({
          modelId: 'openai/gpt-3.5-turbo',
          settings,
          organizationPlan: 'enterprise',
        }).error
      ).not.toBeNull();

      expect(
        checkOrganizationModelRestrictions({
          modelId: 'openai/gpt-4',
          settings,
          organizationPlan: 'enterprise',
        }).error
      ).toBeNull();
    });
  });

  describe('teams plan - model deny list should NOT apply', () => {
    it('should allow any model on teams plan even with model_deny_list set', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          model_deny_list: ['anthropic/claude-3-opus'],
        },
        organizationPlan: 'teams',
      });

      expect(result.error).toBeNull();
    });
  });

  describe('no organization plan (individual users)', () => {
    it('should allow any model when no organization plan is set', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          model_deny_list: ['anthropic/claude-3-opus'],
        },
      });

      expect(result.error).toBeNull();
    });
  });

  describe('provider policy - allow list applies for enterprise plans', () => {
    it('should return provider config with only providers for enterprise plan', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          provider_allow_list: ['openai'],
        },
        organizationPlan: 'enterprise',
      });

      expect(result.error).toBeNull();
      expect(result.providerConfig).toEqual({ only: ['openai'] });
    });

    it('should not return providerConfig for teams plan with provider_allow_list', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          provider_allow_list: ['openai'],
        },
        organizationPlan: 'teams',
      });

      expect(result.error).toBeNull();
      expect(result.providerConfig).toBeUndefined();
    });

    it('should return providerConfig when provider_allow_list is empty', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          provider_allow_list: [],
        },
        organizationPlan: 'enterprise',
      });

      expect(result.error).toBeNull();
      expect(result.providerConfig).toEqual({ only: [] });
    });
  });

  describe('data collection - applies to all plans', () => {
    it('should return data_collection in provider config when set to allow', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          data_collection: 'allow',
        },
        organizationPlan: 'teams',
      });

      expect(result.error).toBeNull();
      expect(result.providerConfig).toEqual({ data_collection: 'allow' });
    });

    it('should return data_collection in provider config when set to deny', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          data_collection: 'deny',
        },
        organizationPlan: 'enterprise',
      });

      expect(result.error).toBeNull();
      expect(result.providerConfig).toEqual({ data_collection: 'deny' });
    });

    it('should combine provider_allow_list and data_collection', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          provider_allow_list: ['openai'],
          data_collection: 'deny',
        },
        organizationPlan: 'enterprise',
      });

      expect(result.error).toBeNull();
      expect(result.providerConfig).toEqual({ only: ['openai'], data_collection: 'deny' });
    });
  });

  describe('no settings', () => {
    it('should return no error and no provider config when settings is undefined', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: undefined,
        organizationPlan: 'enterprise',
      });

      expect(result.error).toBeNull();
      expect(result.providerConfig).toBeUndefined();
    });
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
      has_tools: false,
      feature: null,
      session_id: null,
      mode: null,
      auto_model: null,
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

  it('zeros both cost_mUsd and cacheDiscount_mUsd for BYOK requests', async () => {
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

    countAndStoreEditUsage(response, makeUsageContext({ user_byok: true }), undefined);

    // Allow the async usage parse + after() callback to settle.
    await new Promise(resolve => setImmediate(resolve));

    expect(mockedLogMicrodollarUsage).toHaveBeenCalledTimes(1);
    const [stats] = mockedLogMicrodollarUsage.mock.calls[0];
    expect(stats.cost_mUsd).toBe(0);
    expect(stats.cacheDiscount_mUsd).toBe(0);
    // The pre-zeroed value is preserved in `market_cost` for reporting.
    expect(stats.market_cost).toBe(4_750);
  });

  it('preserves cost_mUsd and cacheDiscount_mUsd for non-BYOK requests', async () => {
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

describe('makeErrorReadable', () => {
  it('returns undefined for non-error responses', async () => {
    const response = new Response('{}', { status: 200 });
    const result = await makeErrorReadable({
      requestedModel: 'anything',
      request: { kind: 'chat_completions', body: { model: 'test', messages: [] } },
      response,
      isUserByok: false,
    });
    expect(result).toBeUndefined();
  });
});
