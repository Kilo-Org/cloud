import { describe, it, expect } from '@jest/globals';
import {
  checkOrganizationModelRestrictions,
  estimateChatTokens,
  wrapInZeroCostResponse,
} from './llm-proxy-helpers';
import type { OpenRouterChatCompletionRequest } from './providers/openrouter/types';

describe('checkOrganizationModelRestrictions', () => {
  describe('enterprise plan - model allow list restrictions', () => {
    it('should allow model when wildcard matches on enterprise plan', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          provider_allow_list: ['anthropic'],
          model_allow_list: ['anthropic/*'],
        },
        organizationPlan: 'enterprise',
      });

      expect(result.error).toBeNull();
    });

    it('should allow model when exact match exists on enterprise plan', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          provider_allow_list: ['anthropic'],
          model_allow_list: ['anthropic/claude-3-opus'],
        },
        organizationPlan: 'enterprise',
      });

      expect(result.error).toBeNull();
    });

    it('should block model when no match and no wildcard on enterprise plan', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          provider_allow_list: ['anthropic'],
          model_allow_list: ['anthropic/claude-3-sonnet'],
        },
        organizationPlan: 'enterprise',
      });

      expect(result.error).not.toBeNull();
      expect(result.error?.status).toBe(404);
    });

    it('should allow any model from provider with wildcard on enterprise plan', () => {
      const settings = {
        provider_allow_list: ['openai'],
        model_allow_list: ['openai/*'],
      };

      const gpt4Result = checkOrganizationModelRestrictions({
        modelId: 'openai/gpt-4',
        settings,
        organizationPlan: 'enterprise',
      });

      const gpt35Result = checkOrganizationModelRestrictions({
        modelId: 'openai/gpt-3.5-turbo',
        settings,
        organizationPlan: 'enterprise',
      });

      expect(gpt4Result.error).toBeNull();
      expect(gpt35Result.error).toBeNull();
    });

    it('should allow when model allow list is empty on enterprise plan', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          provider_allow_list: ['anthropic'],
          model_allow_list: [],
        },
        organizationPlan: 'enterprise',
      });

      expect(result.error).toBeNull();
    });

    it('should handle mixed wildcards and specific models on enterprise plan', () => {
      const settings = {
        provider_allow_list: ['anthropic', 'openai'],
        model_allow_list: ['anthropic/*', 'openai/gpt-4'],
      };

      // Anthropic - any model allowed via wildcard
      expect(
        checkOrganizationModelRestrictions({
          modelId: 'anthropic/claude-3-opus',
          settings,
          organizationPlan: 'enterprise',
        }).error
      ).toBeNull();

      expect(
        checkOrganizationModelRestrictions({
          modelId: 'anthropic/claude-3-sonnet',
          settings,
          organizationPlan: 'enterprise',
        }).error
      ).toBeNull();

      // OpenAI - only gpt-4 allowed
      expect(
        checkOrganizationModelRestrictions({
          modelId: 'openai/gpt-4',
          settings,
          organizationPlan: 'enterprise',
        }).error
      ).toBeNull();

      expect(
        checkOrganizationModelRestrictions({
          modelId: 'openai/gpt-3.5-turbo',
          settings,
          organizationPlan: 'enterprise',
        }).error
      ).not.toBeNull();
    });
  });

  describe('teams plan - model allow list should NOT apply', () => {
    it('should allow any model on teams plan even with model_allow_list set', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          model_allow_list: ['openai/gpt-4'], // Only GPT-4 in allow list
        },
        organizationPlan: 'teams',
      });

      // Teams plan should ignore model_allow_list
      expect(result.error).toBeNull();
    });

    it('should allow blocked model on teams plan that would be blocked on enterprise', () => {
      const settings = {
        model_allow_list: ['anthropic/claude-3-sonnet'],
      };

      // On enterprise, this would be blocked
      const enterpriseResult = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings,
        organizationPlan: 'enterprise',
      });
      expect(enterpriseResult.error).not.toBeNull();

      // On teams, it should be allowed
      const teamsResult = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings,
        organizationPlan: 'teams',
      });
      expect(teamsResult.error).toBeNull();
    });
  });

  describe('no organization plan (individual users)', () => {
    it('should allow any model when no organization plan is set', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          model_allow_list: ['openai/gpt-4'],
        },
        // No organizationPlan - individual user
      });

      expect(result.error).toBeNull();
    });
  });

  describe('provider allow list - applies to enterprise plans', () => {
    it('should return provider config without fields when only provider_allow_list is set for teams', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          provider_allow_list: ['anthropic', 'openai'],
        },
        organizationPlan: 'teams',
      });

      expect(result.error).toBeNull();
      expect(result.providerConfig).toBeUndefined();
    });

    it('should return provider config on enterprise plan too', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          provider_allow_list: ['anthropic'],
        },
        organizationPlan: 'enterprise',
      });

      expect(result.error).toBeNull();
      expect(result.providerConfig).toEqual({ only: ['anthropic'] });
    });

    it('should not return providerConfig when provider_allow_list is empty', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          provider_allow_list: [],
        },
        organizationPlan: 'teams',
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

    it('should combine provider_allow_list and data_collection in provider config', () => {
      const result = checkOrganizationModelRestrictions({
        modelId: 'anthropic/claude-3-opus',
        settings: {
          provider_allow_list: ['anthropic'],
          data_collection: 'deny',
        },
        organizationPlan: 'teams',
      });

      expect(result.error).toBeNull();
      expect(result.providerConfig).toEqual({
        data_collection: 'deny',
      });
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

describe('estimateChatTokens', () => {
  it('should estimate tokens from valid messages', () => {
    const body = {
      model: 'anthropic/claude-3-opus',
      messages: [
        { role: 'user', content: 'Hello, how are you?' },
        { role: 'assistant', content: 'I am doing well, thank you!' },
      ],
    } as OpenRouterChatCompletionRequest;

    const result = estimateChatTokens(body);

    expect(result.estimatedInputTokens).toBeGreaterThan(0);
    expect(result.estimatedOutputTokens).toBeGreaterThan(0);
  });

  it('should handle missing messages gracefully (regression test for KILOCODE-WEB-5ND)', () => {
    // This test ensures we don't crash when messages is undefined/null/invalid
    // which can happen with malformed API requests from abuse attempts
    const undefinedMessages = { model: 'test' } as OpenRouterChatCompletionRequest;
    const nullMessages = {
      model: 'test',
      messages: null,
    } as unknown as OpenRouterChatCompletionRequest;

    expect(estimateChatTokens(undefinedMessages)).toEqual({
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
    });
    expect(estimateChatTokens(nullMessages)).toEqual({
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// wrapInZeroCostResponse
// ---------------------------------------------------------------------------

/** Helper: build a minimal SSE stream from an array of `data: ...` lines. */
function makeSSEStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const payload = lines.map(l => l + '\n\n').join('');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
}

/** Helper: consume a ReadableStream into a string. */
async function streamToText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return '';
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result;
}

describe('wrapInZeroCostResponse', () => {
  describe('streaming SSE responses', () => {
    it('should zero out cost and upstream_inference_cost in usage chunk', async () => {
      const contentChunk = JSON.stringify({
        id: 'gen-abc',
        model: 'anthropic/claude-sonnet-4.6',
        choices: [{ delta: { content: 'Hello' }, index: 0 }],
      });
      const usageChunk = JSON.stringify({
        id: 'gen-abc',
        model: 'anthropic/claude-sonnet-4.6',
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          cost: 0.00312,
          is_byok: false,
          cost_details: { upstream_inference_cost: 0.0028 },
        },
      });

      const response = new Response(
        makeSSEStream([`data: ${contentChunk}`, `data: ${usageChunk}`, 'data: [DONE]']),
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }
      );

      const result = await wrapInZeroCostResponse(response);
      const text = await streamToText(result.body);

      // Parse the usage line from the output
      const dataLines = text
        .split('\n')
        .filter(l => l.startsWith('data: ') && l !== 'data: [DONE]');

      // Content chunk should be present
      expect(dataLines.length).toBe(2);

      // The usage chunk (last data line) should have zeroed cost
      const usageOutput = JSON.parse(dataLines[1].replace('data: ', ''));
      expect(usageOutput.usage.cost).toBe(0);
      expect(usageOutput.usage.cost_details.upstream_inference_cost).toBe(0);

      // Token counts should be preserved
      expect(usageOutput.usage.prompt_tokens).toBe(100);
      expect(usageOutput.usage.completion_tokens).toBe(50);
    });

    it('should pass non-usage content chunks through unchanged', async () => {
      const contentChunk = {
        id: 'gen-abc',
        model: 'anthropic/claude-sonnet-4.6',
        choices: [{ delta: { content: 'Hello world' }, index: 0 }],
      };

      const response = new Response(
        makeSSEStream([`data: ${JSON.stringify(contentChunk)}`, 'data: [DONE]']),
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }
      );

      const result = await wrapInZeroCostResponse(response);
      const text = await streamToText(result.body);

      // The content chunk should pass through (no "usage" key in chunk, so fast path)
      expect(text).toContain('Hello world');
      expect(text).toContain('[DONE]');
    });

    it('should handle [DONE] sentinel correctly', async () => {
      const response = new Response(makeSSEStream(['data: [DONE]']), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });

      const result = await wrapInZeroCostResponse(response);
      const text = await streamToText(result.body);

      expect(text).toContain('data: [DONE]');
    });

    it('should handle usage chunk without cost_details', async () => {
      const usageChunk = JSON.stringify({
        id: 'gen-abc',
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          cost: 0.005,
        },
      });

      const response = new Response(makeSSEStream([`data: ${usageChunk}`, 'data: [DONE]']), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });

      const result = await wrapInZeroCostResponse(response);
      const text = await streamToText(result.body);
      const dataLines = text
        .split('\n')
        .filter(l => l.startsWith('data: ') && l !== 'data: [DONE]');

      const usageOutput = JSON.parse(dataLines[0].replace('data: ', ''));
      expect(usageOutput.usage.cost).toBe(0);
      expect(usageOutput.usage.cost_details).toBeUndefined();
    });

    it('should preserve response status and status text', async () => {
      const response = new Response(makeSSEStream(['data: [DONE]']), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'text/event-stream' },
      });

      const result = await wrapInZeroCostResponse(response);
      expect(result.status).toBe(200);
    });
  });

  describe('JSON (non-streaming) responses', () => {
    it('should zero out cost in usage object', async () => {
      const body = {
        id: 'gen-abc',
        model: 'anthropic/claude-sonnet-4.6',
        choices: [{ message: { role: 'assistant', content: 'Hello' } }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          cost: 0.00312,
          is_byok: false,
          cost_details: { upstream_inference_cost: 0.0028 },
        },
      };

      const response = new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

      const result = await wrapInZeroCostResponse(response);
      const json = await result.json();

      expect(json.usage.cost).toBe(0);
      expect(json.usage.cost_details.upstream_inference_cost).toBe(0);
      expect(json.usage.prompt_tokens).toBe(100);
      expect(json.usage.completion_tokens).toBe(50);
    });

    it('should pass through response without usage field unchanged', async () => {
      const body = {
        id: 'gen-abc',
        model: 'anthropic/claude-sonnet-4.6',
        choices: [{ message: { role: 'assistant', content: 'Hello' } }],
      };

      const response = new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

      const result = await wrapInZeroCostResponse(response);
      const json = await result.json();

      expect(json.id).toBe('gen-abc');
      expect(json.usage).toBeUndefined();
    });

    it('should handle malformed JSON gracefully', async () => {
      const response = new Response('not valid json{{{', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

      const result = await wrapInZeroCostResponse(response);
      const text = await result.text();

      expect(text).toBe('not valid json{{{');
      expect(result.status).toBe(200);
    });
  });

  describe('edge cases', () => {
    it('should handle response with no body', async () => {
      const response = new Response(null, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });

      const result = await wrapInZeroCostResponse(response);
      expect(result.status).toBe(200);
      expect(result.body).toBeNull();
    });
  });
});
