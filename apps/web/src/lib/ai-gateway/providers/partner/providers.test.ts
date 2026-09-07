import { describe, expect, test } from '@jest/globals';

import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import { PERPLEXITY_KIMI_PUBLIC_ID } from '@/lib/ai-gateway/providers/partner/constants';
import { PERPLEXITY_KIMI_PROVIDER } from '@/lib/ai-gateway/providers/partner/providers';
import {
  ReasoningDetailsTransform,
  type TransformRequestContext,
} from '@/lib/ai-gateway/providers/types';

describe('Perplexity Kimi provider', () => {
  test('supports the chat completions API', () => {
    expect(`${PERPLEXITY_KIMI_PROVIDER.apiUrl}/chat/completions`).toBe(
      'https://api.perplexity.ai/router/v1/chat/completions'
    );
    expect(PERPLEXITY_KIMI_PROVIDER.supportedChatApis).toEqual(['chat_completions']);
  });

  test('enables the reasoning details response transform', () => {
    expect(PERPLEXITY_KIMI_PROVIDER.responseTransforms).toBe(
      ReasoningDetailsTransform.ReasoningContent
    );
  });

  test('hardwires the upstream model and removes provider and user settings', async () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: PERPLEXITY_KIMI_PUBLIC_ID,
        messages: [{ role: 'user', content: 'hello' }],
        provider: { order: ['perplexity'] },
        user: 'user-id',
      },
    };

    await PERPLEXITY_KIMI_PROVIDER.transformRequest({ request } as TransformRequestContext);

    expect(request.body.model).toBe('perplexity/kimi-k3');
    expect(request.body.provider).toBeUndefined();
    expect(request.body.user).toBeUndefined();
  });

  test.each([
    [{ enabled: false as const, effort: 'none' as const }, 'none'],
    [{ enabled: true as const, effort: 'high' as const }, 'high'],
  ])('maps reasoning %p to Perplexity effort %s', async (reasoning, expected) => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: PERPLEXITY_KIMI_PUBLIC_ID,
        messages: [{ role: 'user', content: 'hello' }],
        reasoning,
        reasoning_effort: 'low',
      },
    };

    await PERPLEXITY_KIMI_PROVIDER.transformRequest({ request } as TransformRequestContext);

    expect(request.body.reasoning_effort).toBe(expected);
    expect(request.body.reasoning).toBeUndefined();
  });

  test.each(['none', 'low', undefined] as const)(
    'preserves legacy reasoning effort %p when reasoning settings are absent',
    async reasoning_effort => {
      const request: GatewayRequest = {
        kind: 'chat_completions',
        body: {
          model: PERPLEXITY_KIMI_PUBLIC_ID,
          messages: [{ role: 'user', content: 'hello' }],
          reasoning_effort,
        },
      };

      await PERPLEXITY_KIMI_PROVIDER.transformRequest({ request } as TransformRequestContext);

      expect(request.body.reasoning_effort).toBe(reasoning_effort);
    }
  );
});
