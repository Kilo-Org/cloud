import { describe, expect, test } from '@jest/globals';

import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import {
  FRIENDLI_GLM_PUBLIC_ID,
  PERPLEXITY_KIMI_PUBLIC_ID,
} from '@/lib/ai-gateway/providers/partner/constants';
import {
  FRIENDLI_GLM_PROVIDER,
  PERPLEXITY_KIMI_PROVIDER,
} from '@/lib/ai-gateway/providers/partner/providers';
import {
  ReasoningDetailsTransform,
  type TransformRequestContext,
} from '@/lib/ai-gateway/providers/types';

describe.each([
  {
    name: 'Friendli GLM',
    provider: FRIENDLI_GLM_PROVIDER,
    expectedUrl: 'https://api.friendli.ai/serverless/v1/chat/completions',
    requestedModel: FRIENDLI_GLM_PUBLIC_ID,
    upstreamModel: 'zai-org/GLM-5.2',
  },
  {
    name: 'Perplexity Kimi',
    provider: PERPLEXITY_KIMI_PROVIDER,
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

    await FRIENDLI_GLM_PROVIDER.transformRequest({ request } as TransformRequestContext);

    expect(request.body).toMatchObject(expected);
    expect(request.body.reasoning).toBeUndefined();
  });
});
