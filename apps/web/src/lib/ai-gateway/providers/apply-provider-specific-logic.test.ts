import { describe, expect, it } from '@jest/globals';
import { CLAUDE_OPUS_FALLBACK_MODEL_ID } from '@/lib/ai-gateway/providers/anthropic.constants';
import {
  applyGatewayModelsFallback,
  applyPreferredProvider,
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
  it.each([
    ['openrouter', 'anthropic/claude-fable-5'],
    ['vercel', 'anthropic/claude-fable-5'],
    ['openrouter', 'anthropic/claude-opus-5'],
    ['vercel', 'anthropic/claude-opus-5'],
  ] satisfies [ProviderId, string][])(
    'sets Opus 4.8 as the fallback for %s requests to %s',
    async (providerId, requestedModel) => {
      const request = makeRequest(requestedModel, ['caller/fallback']);

      await applyGatewayModelsFallback(providerId, requestedModel, request);

      expect(request.body.models).toEqual([requestedModel, CLAUDE_OPUS_FALLBACK_MODEL_ID]);
    }
  );

  it.each(['anthropic/claude-fable-5', 'anthropic/claude-opus-5'])(
    'removes caller-provided fallbacks for %s on other providers',
    async requestedModel => {
      const request = makeRequest(requestedModel, ['caller/fallback']);

      await applyGatewayModelsFallback('martian', requestedModel, request);

      expect(request.body.models).toBeUndefined();
    }
  );

  it.each(['anthropic/claude-opus-4.8', 'anthropic/claude-opus-6', 'openai/gpt-4o'])(
    'removes caller-provided fallbacks for other model %s',
    async requestedModel => {
      const request = makeRequest(requestedModel, ['caller/fallback']);

      await applyGatewayModelsFallback('openrouter', requestedModel, request);

      expect(request.body.models).toBeUndefined();
    }
  );
});

describe('applyPreferredProvider', () => {
  it.each(['openai/gpt-5.6-terra', 'openai/o3', 'gpt-5.5'])(
    'prefers OpenAI for OpenAI model %s',
    model => {
      const request = makeRequest(model);

      applyPreferredProvider(model, request.body);

      expect(request.body.provider).toEqual({ order: ['openai'] });
    }
  );

  it('does not set a provider order for GPT-OSS', () => {
    const model = 'openai/gpt-oss-120b';
    const request = makeRequest(model);

    applyPreferredProvider(model, request.body);

    expect(request.body.provider).toBeUndefined();
  });

  it('does not set a provider order for Fable', () => {
    const request = makeRequest('anthropic/claude-fable-5');

    applyPreferredProvider('anthropic/claude-fable-5', request.body);

    expect(request.body.provider).toBeUndefined();
  });

  it('preserves valid provider options when adding order', () => {
    const request = makeRequest('anthropic/claude-sonnet-4.5');
    request.body.provider = { zdr: true };

    applyPreferredProvider('anthropic/claude-sonnet-4.5', request.body);

    expect(request.body.provider).toEqual({
      zdr: true,
      order: ['amazon-bedrock', 'anthropic'],
    });
  });

  it('prefers Novita for DeepSeek models', () => {
    const request = makeRequest('deepseek/deepseek-v4-pro');

    applyPreferredProvider('deepseek/deepseek-v4-pro', request.body);

    expect(request.body.provider).toEqual({ order: ['novita'] });
  });

  it('overwrites a malformed provider value', () => {
    const request = makeRequest('anthropic/claude-sonnet-4.5');
    Object.assign(request.body, { provider: 'lmstudio' });

    applyPreferredProvider('anthropic/claude-sonnet-4.5', request.body);

    expect(request.body.provider).toEqual({ order: ['amazon-bedrock', 'anthropic'] });
  });
});
