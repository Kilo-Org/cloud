import { describe, it, expect } from '@jest/globals';
import {
  checkOrganizationModelRestrictions,
  extractEmbeddingPromptInfo,
  makeErrorReadable,
  parseEmbeddingUsageFromResponse,
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

  describe('provider policy - allow list applies after migration marker', () => {
    it('should return provider config with only providers for enterprise plan', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          provider_policy_mode: 'allow',
          provider_allow_list: ['openai'],
        },
        organizationPlan: 'enterprise',
      });

      expect(result.error).toBeNull();
      expect(result.providerConfig).toEqual({ only: ['openai'] });
    });

    it('should prefer provider_allow_list over legacy provider_deny_list after migration', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          provider_policy_mode: 'allow',
          provider_allow_list: ['openai'],
          provider_deny_list: ['openai'],
        },
        organizationPlan: 'enterprise',
      });

      expect(result.error).toBeNull();
      expect(result.providerConfig).toEqual({ only: ['openai'] });
    });

    it('should ignore stale provider_allow_list without policy marker', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          provider_allow_list: ['openai'],
        },
        organizationPlan: 'enterprise',
      });

      expect(result.error).toBeNull();
      expect(result.providerConfig).toBeUndefined();
    });

    it('should fall back to provider_deny_list before provider allow policy is enabled', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          provider_allow_list: ['openai'],
          provider_deny_list: ['anthropic'],
        },
        organizationPlan: 'enterprise',
      });

      expect(result.error).toBeNull();
      expect(result.providerConfig).toEqual({ ignore: ['anthropic'] });
    });

    it('should not return providerConfig for teams plan with provider_allow_list', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          provider_policy_mode: 'allow',
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
          provider_policy_mode: 'allow',
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

    it('should combine provider_deny_list and data_collection before provider migration', () => {
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

    it('should combine provider_allow_list and data_collection after provider migration', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          provider_policy_mode: 'allow',
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
