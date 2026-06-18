import { describe, expect, it } from '@jest/globals';
import { CLAUDE_OPUS_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/anthropic.constants';
import {
  applyOpenRouterStructuredOutputRouting,
  applyGatewayModelsFallback,
} from '@/lib/ai-gateway/providers/apply-provider-specific-logic';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import type { ProviderId } from '@/lib/ai-gateway/providers/types';

function makeRequest(model: string, models?: string[]): GatewayRequest {
  return {
    kind: 'chat_completions',
    body: {
      model,
      models,
      messages: [{ role: 'user', content: 'hello' }],
    },
  };
}

describe('applyGatewayModelsFallback', () => {
  it.each<ProviderId>(['openrouter', 'vercel'])(
    'sets Opus as the Fable fallback for the %s provider',
    providerId => {
      const request = makeRequest('anthropic/claude-fable-5', ['caller/fallback']);

      applyGatewayModelsFallback(providerId, 'anthropic/claude-fable-5', request);

      expect(request.body.models).toEqual([
        'anthropic/claude-fable-5',
        CLAUDE_OPUS_CURRENT_MODEL_ID,
      ]);
    }
  );

  it('removes caller-provided fallbacks for Fable on other providers', () => {
    const request = makeRequest('anthropic/claude-fable-5', ['caller/fallback']);

    applyGatewayModelsFallback('martian', 'anthropic/claude-fable-5', request);

    expect(request.body.models).toBeUndefined();
  });

  it('removes caller-provided fallbacks for other models', () => {
    const request = makeRequest('openai/gpt-4o', ['caller/fallback']);

    applyGatewayModelsFallback('openrouter', 'openai/gpt-4o', request);

    expect(request.body.models).toBeUndefined();
  });
});

describe('applyOpenRouterStructuredOutputRouting', () => {
  it('requires structured-output support from OpenRouter providers', () => {
    const request = makeStructuredOutputRequest();
    request.body.provider = { only: ['anthropic'] };

    applyOpenRouterStructuredOutputRouting('openrouter', request);

    expect(request.body.provider).toEqual({
      only: ['anthropic'],
      require_parameters: true,
    });
  });

  it.each<ProviderId>(['direct-byok', 'custom', 'experiment', 'vercel'])(
    'does not send OpenRouter routing controls to %s',
    providerId => {
      const request = makeStructuredOutputRequest();

      applyOpenRouterStructuredOutputRouting(providerId, request);

      expect(request.body.provider).toBeUndefined();
    }
  );
});

function makeStructuredOutputRequest(): GatewayRequest {
  return {
    kind: 'chat_completions',
    body: {
      model: 'anthropic/claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'hello' }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'result',
          strict: true,
          schema: {
            type: 'object',
            properties: { result: { type: 'string' } },
            required: ['result'],
            additionalProperties: false,
          },
        },
      },
    },
  };
}
