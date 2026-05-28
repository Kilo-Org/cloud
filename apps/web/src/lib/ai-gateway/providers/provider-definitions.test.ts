import { describe, expect, it } from '@jest/globals';
import { EmptyFraudDetectionHeaders } from '@/lib/utils';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import PROVIDERS from '@/lib/ai-gateway/providers/provider-definitions';

function transformMartianRequest(request: GatewayRequest, model: string) {
  PROVIDERS.MARTIAN.transformRequest({
    model,
    request,
    originalHeaders: EmptyFraudDetectionHeaders,
    extraHeaders: {},
    userByok: null,
  });
}

describe('Martian provider', () => {
  it('does not forward OpenRouter provider options through the Messages API', () => {
    const request: GatewayRequest = {
      kind: 'messages',
      body: {
        model: 'anthropic/claude-opus-4-7:optimized',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Hello' }],
        provider: { data_collection: 'allow', only: ['stealth'] },
      },
    };

    transformMartianRequest(request, 'stealth/claude-opus-4.7');

    expect(request.body.provider).toBeUndefined();
  });

  it('leaves provider options intact through the existing Responses API path', () => {
    const request: GatewayRequest = {
      kind: 'responses',
      body: {
        model: 'x-ai/grok-code-fast-1:optimized',
        input: 'Hello',
        provider: { data_collection: 'allow', only: ['stealth'] },
      },
    };

    transformMartianRequest(request, 'x-ai/grok-code-fast-1:optimized:free');

    expect(request.body.provider).toEqual({ data_collection: 'allow', only: ['stealth'] });
  });
});
