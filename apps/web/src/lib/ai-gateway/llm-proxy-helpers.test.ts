import { describe, it, expect } from '@jest/globals';
import {
  checkOrganizationModelRestrictions,
  estimateTokenCount,
  extractEmbeddingPromptInfo,
  makeErrorReadable,
  parseEmbeddingUsageFromResponse,
  ProxyErrorType,
} from './llm-proxy-helpers';
import type {
  GatewayRequest,
  OpenRouterChatCompletionRequest,
} from '@/lib/ai-gateway/providers/openrouter/types';
import { morph_warp_grep_free_model } from '@/lib/ai-gateway/providers/morph';

function chatRequest(body: OpenRouterChatCompletionRequest): GatewayRequest {
  return { kind: 'chat_completions', body };
}

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
        // No organizationPlan - individual user
      });

      expect(result.error).toBeNull();
    });
  });

  describe('provider deny list - applies to enterprise plans', () => {
    it('should return provider config with ignored providers for enterprise plan', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          provider_deny_list: ['openai'],
        },
        organizationPlan: 'enterprise',
      });

      expect(result.error).toBeNull();
      expect(result.providerConfig).toEqual({ ignore: ['openai'] });
    });

    it('should not return providerConfig for teams plan with provider_deny_list', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          provider_deny_list: ['openai'],
        },
        organizationPlan: 'teams',
      });

      expect(result.error).toBeNull();
      expect(result.providerConfig).toBeUndefined();
    });

    it('should not return providerConfig when provider_deny_list is empty', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          provider_deny_list: [],
        },
        organizationPlan: 'enterprise',
      });

      expect(result.error).toBeNull();
      expect(result.providerConfig).toBeUndefined();
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

    it('should combine provider_deny_list and data_collection in provider config', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          provider_deny_list: ['openai'],
          data_collection: 'deny',
        },
        organizationPlan: 'enterprise',
      });

      expect(result.error).toBeNull();
      expect(result.providerConfig).toEqual({ ignore: ['openai'], data_collection: 'deny' });
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

    const result = parseEmbeddingUsageFromResponse(response);

    // toMicrodollars(0.00005) = Math.round(0.00005 * 1_000_000) = 50
    expect(result.cost_mUsd).toBe(50);
  });

  it('should default to 0 cost when upstream cost field is absent', () => {
    const response = makeResponse({
      usage: { prompt_tokens: 1000, total_tokens: 1000 },
    });

    const result = parseEmbeddingUsageFromResponse(response);

    expect(result.cost_mUsd).toBe(0);
  });

  it('should extract id as messageId', () => {
    const response = makeResponse({ id: 'embd-abc' });

    const result = parseEmbeddingUsageFromResponse(response);

    expect(result.messageId).toBe('embd-abc');
  });

  it('should set messageId to null when id is absent', () => {
    const response = makeResponse({});
    const parsed = JSON.parse(response);
    delete parsed.id;

    const result = parseEmbeddingUsageFromResponse(JSON.stringify(parsed));

    expect(result.messageId).toBeNull();
  });

  it('should set hasError to true when model is empty', () => {
    const response = makeResponse({ model: '' });

    const result = parseEmbeddingUsageFromResponse(response);

    expect(result.hasError).toBe(true);
  });

  it('should set hasError to false when model is present', () => {
    const response = makeResponse({ model: 'text-embedding-3-small' });

    const result = parseEmbeddingUsageFromResponse(response);

    expect(result.hasError).toBe(false);
  });

  it('should always set outputTokens to 0 and streamed/cancelled to false', () => {
    const response = makeResponse();

    const result = parseEmbeddingUsageFromResponse(response);

    expect(result.outputTokens).toBe(0);
    expect(result.streamed).toBe(false);
    expect(result.cancelled).toBe(false);
  });

  it('should extract prompt_tokens as inputTokens', () => {
    const response = makeResponse({
      usage: { prompt_tokens: 42, total_tokens: 42 },
    });

    const result = parseEmbeddingUsageFromResponse(response);

    expect(result.inputTokens).toBe(42);
  });
});

describe('estimateTokenCount', () => {
  it('counts only text content, not JSON keys and punctuation', () => {
    const request = chatRequest({
      model: 'foo',
      messages: [{ role: 'user', content: 'hello world' }],
    });

    // 'foo' (3) + 'user' (4) + 'hello world' (11) = 18 chars / 4 = 4.5 → rounded to 5
    expect(estimateTokenCount(request)).toBe(5);
  });

  it('adds max_tokens to the estimate', () => {
    const request = chatRequest({
      model: '',
      messages: [{ role: 'user', content: 'x'.repeat(400) }],
      max_tokens: 1000,
    });

    // 400 chars from content + 4 chars from 'user' = 404 / 4 = 101, plus 1000 reserved.
    expect(estimateTokenCount(request)).toBe(1101);
  });

  it('recurses into nested structures like tool definitions', () => {
    const request = chatRequest({
      model: '',
      messages: [],
      tools: [
        {
          type: 'function',
          function: { name: 'do_thing', description: 'x'.repeat(100) },
        },
      ],
    });

    // 'function' (8) + 'function' (8) + 'do_thing' (8) + 'x' * 100 = 124 / 4 = 31
    expect(estimateTokenCount(request)).toBe(31);
  });
});

describe('makeErrorReadable', () => {
  const emptyRequest: GatewayRequest = chatRequest({ model: 'test', messages: [] });

  it('returns undefined for non-error responses', async () => {
    const response = new Response('{}', { status: 200 });
    const result = await makeErrorReadable({
      requestedModel: 'anything',
      request: emptyRequest,
      response,
      isUserByok: false,
    });
    expect(result).toBeUndefined();
  });

  it('converts upstream context-length errors into a context_length_exceeded response', async () => {
    const upstreamBody = JSON.stringify({
      error: {
        message:
          "This endpoint's maximum context length is 204800 tokens. However, you requested about 301688 tokens (124054 of text input, 145634 of tool input, 32000 in the output). Please reduce the length of either one, or use the context-compression plugin to compress your prompt automatically.",
      },
    });
    const response = new Response(upstreamBody, { status: 400 });

    const result = await makeErrorReadable({
      requestedModel: 'some-unknown-model',
      request: emptyRequest,
      response,
      isUserByok: false,
    });

    if (!result) throw new Error('expected a response');
    const json = await result.json();
    expect(json.error_type).toBe(ProxyErrorType.context_length_exceeded);
    expect(String(json.message)).toMatch(/maximum context length/i);
  });

  it('converts a generic 500 into context_length_exceeded when our estimate exceeds the window', async () => {
    // morph_warp_grep_free_model has context_length 256_000 and max_completion_tokens 32_000.
    // Provide ~1_000_000 text chars so the estimate (~250k + 32k = ~282k) exceeds the window.
    const hugeRequest = chatRequest({
      model: morph_warp_grep_free_model.public_id,
      messages: [{ role: 'user', content: 'x'.repeat(1_000_000) }],
      max_tokens: 32_000,
    });

    const response = new Response('Internal Server Error', { status: 500 });

    const result = await makeErrorReadable({
      requestedModel: morph_warp_grep_free_model.public_id,
      request: hugeRequest,
      response,
      isUserByok: false,
    });

    if (!result) throw new Error('expected a response');
    const json = await result.json();
    expect(json.error_type).toBe(ProxyErrorType.context_length_exceeded);
    expect(String(json.message)).toMatch(/maximum context length/i);
  });

  it('does not trigger context_length_exceeded on a 500 when the estimate fits the window', async () => {
    const smallRequest = chatRequest({
      model: morph_warp_grep_free_model.public_id,
      messages: [{ role: 'user', content: 'hi' }],
    });

    const response = new Response('Internal Server Error', { status: 500 });

    const result = await makeErrorReadable({
      requestedModel: morph_warp_grep_free_model.public_id,
      request: smallRequest,
      response,
      isUserByok: false,
    });

    expect(result).toBeUndefined();
  });
});
