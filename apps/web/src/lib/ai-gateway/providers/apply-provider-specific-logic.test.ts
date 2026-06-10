import { describe, expect, it } from '@jest/globals';
import { CLAUDE_OPUS_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/anthropic.constants';
import { applyOpenRouterModelsFallback } from '@/lib/ai-gateway/providers/apply-provider-specific-logic';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';

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

describe('applyOpenRouterModelsFallback', () => {
  it('sets Opus as the fallback for Fable requests', () => {
    const request = makeRequest('anthropic/claude-fable-5', ['caller/fallback']);

    applyOpenRouterModelsFallback(request.body.model, request);

    expect(request.body.models).toEqual([request.body.model, CLAUDE_OPUS_CURRENT_MODEL_ID]);
  });

  it('removes caller-provided fallbacks for other models', () => {
    const request = makeRequest('openai/gpt-4o', ['caller/fallback']);

    applyOpenRouterModelsFallback(request.body.model, request);

    expect(request.body.models).toBeUndefined();
  });
});
