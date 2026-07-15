import { describe, expect, it } from '@jest/globals';
import { CLAUDE_OPUS_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/anthropic.constants';
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
  it.each<ProviderId>(['openrouter', 'vercel'])(
    'sets Opus as the Fable fallback for the %s provider',
    async providerId => {
      const request = makeRequest('anthropic/claude-fable-5', ['caller/fallback']);

      await applyGatewayModelsFallback(providerId, 'anthropic/claude-fable-5', request);

      expect(request.body.models).toEqual([
        'anthropic/claude-fable-5',
        CLAUDE_OPUS_CURRENT_MODEL_ID,
      ]);
    }
  );

  it('removes caller-provided fallbacks for Fable on other providers', async () => {
    const request = makeRequest('anthropic/claude-fable-5', ['caller/fallback']);

    await applyGatewayModelsFallback('martian', 'anthropic/claude-fable-5', request);

    expect(request.body.models).toBeUndefined();
  });

  it('removes caller-provided fallbacks for other models', async () => {
    const request = makeRequest('openai/gpt-4o', ['caller/fallback']);

    await applyGatewayModelsFallback('openrouter', 'openai/gpt-4o', request);

    expect(request.body.models).toBeUndefined();
  });
});

describe('applyPreferredProvider', () => {
  it('preserves valid provider options when adding order', () => {
    const request = makeRequest('anthropic/claude-sonnet-4.5');
    request.body.provider = { zdr: true };

    applyPreferredProvider('anthropic/claude-sonnet-4.5', request.body);

    expect(request.body.provider).toEqual({
      zdr: true,
      order: ['amazon-bedrock', 'anthropic'],
    });
  });

  it('overwrites a malformed provider value', () => {
    const request = makeRequest('anthropic/claude-sonnet-4.5');
    Object.assign(request.body, { provider: 'lmstudio' });

    applyPreferredProvider('anthropic/claude-sonnet-4.5', request.body);

    expect(request.body.provider).toEqual({ order: ['amazon-bedrock', 'anthropic'] });
  });
});
