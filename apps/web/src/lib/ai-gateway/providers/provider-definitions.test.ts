import { describe, expect, test } from '@jest/globals';

import PROVIDERS from '@/lib/ai-gateway/providers/provider-definitions';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import type { TransformRequestContext } from '@/lib/ai-gateway/providers/types';
import { PERPLEXITY_KIMI_PUBLIC_ID } from '@/lib/ai-gateway/providers/moonshotai';
import { FRIENDLI_GLM_PUBLIC_ID } from '@/lib/ai-gateway/providers/zai';

describe('LongCat provider', () => {
  test('targets the LongCat chat completions endpoint', () => {
    expect(`${PROVIDERS.LONGCAT.apiUrl}/chat/completions`).toBe(
      'https://api.longcat.ai/openai/v1/chat/completions'
    );
    expect(PROVIDERS.LONGCAT.supportedChatApis).toEqual(['chat_completions']);
  });

  test.each([
    [undefined, 'enabled'],
    [{ enabled: true as const }, 'enabled'],
    [{ enabled: false as const, effort: 'none' as const }, 'disabled'],
  ])('maps reasoning %p to Anthropic-style thinking %s', async (reasoning, expectedType) => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'LongCat-2.0',
        messages: [{ role: 'user', content: 'hello' }],
        reasoning,
        provider: { order: ['longcat'] },
      },
    };

    await PROVIDERS.LONGCAT.transformRequest({ request } as TransformRequestContext);

    expect(request.body.thinking).toEqual({ type: expectedType });
    expect(request.body.provider).toBeUndefined();
  });
});

describe.each([
  {
    name: 'Friendli GLM',
    provider: PROVIDERS.FRIENDLI_GLM,
    expectedUrl: 'https://api.friendli.ai/serverless/v1/messages',
    requestedModel: FRIENDLI_GLM_PUBLIC_ID,
    upstreamModel: 'zai-org/GLM-5.2',
  },
  {
    name: 'Perplexity Kimi',
    provider: PROVIDERS.PERPLEXITY_KIMI,
    expectedUrl: 'https://api.perplexity.ai/router/v1/messages',
    requestedModel: PERPLEXITY_KIMI_PUBLIC_ID,
    upstreamModel: 'perplexity/kimi-k3',
  },
])('$name provider', ({ provider, expectedUrl, requestedModel, upstreamModel }) => {
  test('supports Messages only', () => {
    expect(`${provider.apiUrl}/messages`).toBe(expectedUrl);
    expect(provider.supportedChatApis).toEqual(['messages']);
  });

  test('hardwires the upstream model and removes provider settings', async () => {
    const request: GatewayRequest = {
      kind: 'messages',
      body: {
        model: requestedModel,
        max_tokens: 1_024,
        messages: [{ role: 'user', content: 'hello' }],
        provider: { order: ['friendli'] },
      },
    };

    await provider.transformRequest({ request } as TransformRequestContext);

    expect(request.body.model).toBe(upstreamModel);
    expect(request.body.provider).toBeUndefined();
  });
});
