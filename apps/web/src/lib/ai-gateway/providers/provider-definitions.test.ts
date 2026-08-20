import { describe, expect, test } from '@jest/globals';

import {
  getProviderById,
  LONGCAT,
  OPENROUTER,
} from '@/lib/ai-gateway/providers/provider-definitions';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import type { TransformRequestContext } from '@/lib/ai-gateway/providers/types';

describe('LongCat provider', () => {
  test('targets the LongCat chat completions endpoint', () => {
    expect(`${LONGCAT.apiUrl}/chat/completions`).toBe(
      'https://api.longcat.ai/openai/v1/chat/completions'
    );
    expect(LONGCAT.supportedChatApis).toEqual(['chat_completions']);
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

    await LONGCAT.transformRequest({ request } as TransformRequestContext);

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

    await LONGCAT.transformRequest({
      request,
      extraHeaders,
    } as TransformRequestContext);

    expect(extraHeaders['Mt-User-Id']).toBe('hashed-user-id');
  });
});

describe('getProviderById', () => {
  test('resolves static provider definitions', () => {
    expect(getProviderById('openrouter')).toBe(OPENROUTER);
  });

  test('does not claim dynamically constructed providers', () => {
    expect(getProviderById('direct-byok')).toBeUndefined();
    expect(getProviderById('friendli')).toBeUndefined();
  });
});
