import { describe, expect, test } from '@jest/globals';

import PROVIDERS from '@/lib/ai-gateway/providers/provider-definitions';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import type { TransformRequestContext } from '@/lib/ai-gateway/providers/types';
import { ReasoningDetailsTransform } from '@/lib/ai-gateway/providers/types';
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

  test('forwards the hashed user ID in the LongCat header', async () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'LongCat-2.0',
        messages: [{ role: 'user', content: 'hello' }],
        user: 'hashed-user-id',
      },
    };
    const extraHeaders: Record<string, string> = {};

    await PROVIDERS.LONGCAT.transformRequest({
      request,
      extraHeaders,
    } as TransformRequestContext);

    expect(extraHeaders['Mt-User-Id']).toBe('hashed-user-id');
  });
});

describe.each([
  {
    name: 'Friendli GLM',
    provider: PROVIDERS.FRIENDLI_GLM,
    expectedUrl: 'https://api.friendli.ai/serverless/v1/chat/completions',
    requestedModel: FRIENDLI_GLM_PUBLIC_ID,
    upstreamModel: 'zai-org/GLM-5.2',
  },
  {
    name: 'Perplexity Kimi',
    provider: PROVIDERS.PERPLEXITY_KIMI,
    expectedUrl: 'https://api.perplexity.ai/router/v1/chat/completions',
    requestedModel: PERPLEXITY_KIMI_PUBLIC_ID,
    upstreamModel: 'perplexity/kimi-k3',
  },
])('$name provider', ({ provider, expectedUrl, requestedModel, upstreamModel }) => {
  test('supports the chat completions API', () => {
    expect(`${provider.apiUrl}/chat/completions`).toBe(expectedUrl);
    expect(provider.supportedChatApis).toEqual(['chat_completions']);
  });

  test('enables the reasoning details response transform', () => {
    expect(provider.responseTransforms).toBe(ReasoningDetailsTransform.ReasoningContent);
  });

  test('hardwires the upstream model and removes provider settings', async () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: requestedModel,
        messages: [{ role: 'user', content: 'hello' }],
        provider: { order: ['friendli'] },
      },
    };

    await provider.transformRequest({ request } as TransformRequestContext);

    expect(request.body.model).toBe(upstreamModel);
    expect(request.body.provider).toBeUndefined();
  });
});

describe('Friendli GLM reasoning', () => {
  test.each([
    [
      { enabled: false as const, effort: 'none' as const },
      { chat_template_kwargs: { enable_thinking: false } },
    ],
    [
      { enabled: true as const, effort: 'high' as const },
      {
        chat_template_kwargs: { enable_thinking: true },
        reasoning_effort: 'high',
        parse_reasoning: true,
        include_reasoning: true,
      },
    ],
  ])('maps reasoning %p to Friendli settings', async (reasoning, expected) => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: FRIENDLI_GLM_PUBLIC_ID,
        messages: [{ role: 'user', content: 'hello' }],
        reasoning,
      },
    };

    await PROVIDERS.FRIENDLI_GLM.transformRequest({ request } as TransformRequestContext);

    expect(request.body).toMatchObject(expected);
    expect(request.body.reasoning).toBeUndefined();
  });
});
