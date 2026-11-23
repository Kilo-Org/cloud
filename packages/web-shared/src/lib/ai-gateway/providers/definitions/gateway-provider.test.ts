import { describe, expect, test } from '@jest/globals';
import { dropThinkingBlocksOnPrefixMismatch } from '@kilocode/web-shared/lib/ai-gateway/providers/anthropic/thinking-block-binding';
import { defineGatewayProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/gateway-provider';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import type {
  Provider,
  TransformRequestContext,
} from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { EmptyFraudDetectionHeaders } from '@kilocode/web-shared/lib/fraud-detection-headers';

const MODEL = 'anthropic/claude-opus-5.5';

type MessagesRequest = Extract<GatewayRequest, { kind: 'messages' }>;

/** Carries every field the thinking-block binding reads: model, kind, thinking, and one binding block. */
function makeMessagesRequest(): MessagesRequest {
  return {
    kind: 'messages',
    body: {
      model: MODEL,
      max_tokens: 2_048,
      thinking: { type: 'adaptive' },
      messages: [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'Use the read tool.',
              signature: 'FAKE_PROVIDER_TEST_SIGNATURE',
            },
            { type: 'redacted_thinking', data: 'FAKE_PROVIDER_TEST_REDACTED_DATA' },
            { type: 'text', text: 'Previous answer.' },
          ],
        },
        { role: 'user', content: 'Continue.' },
      ],
    },
  };
}

function makeContext(
  provider: Provider,
  request: MessagesRequest,
  extraHeaders: Record<string, string>
): TransformRequestContext {
  return {
    provider,
    model: MODEL,
    request,
    originalHeaders: EmptyFraudDetectionHeaders,
    extraHeaders,
    userByok: null,
    kilo_user_id: 'user-1',
    organization_id: null,
    session_id: null,
  };
}

describe('defineGatewayProvider transformRequest', () => {
  test('leaves the request and headers untouched when the definition omits a transform', async () => {
    const provider = defineGatewayProvider({
      type: 'openrouter',
      apiUrl: 'https://example.test/api',
      apiKey: 'k',
    });
    const request = makeMessagesRequest();
    const extraHeaders: Record<string, string> = {};

    await provider.transformRequest(makeContext(provider, request, extraHeaders));

    expect(request).toEqual(makeMessagesRequest());
    expect(request.body.thinking).toEqual({ type: 'adaptive' });
    expect(extraHeaders).toEqual({});
    expect(extraHeaders['anthropic-beta']).toBeUndefined();
  });

  test('applies the transform the definition declares', async () => {
    const provider = defineGatewayProvider({
      type: 'openrouter',
      apiUrl: 'https://example.test/api',
      apiKey: 'k',
      transformRequest: dropThinkingBlocksOnPrefixMismatch,
    });
    const request = makeMessagesRequest();
    const extraHeaders: Record<string, string> = {};

    await provider.transformRequest(makeContext(provider, request, extraHeaders));

    expect(request.body.thinking).toEqual({
      type: 'adaptive',
      block_binding: { prefix_mismatch_behavior: 'drop_block' },
    });
    expect(extraHeaders['anthropic-beta']).toBe('thinking-binding-controls-2026-08-01');
  });
});
