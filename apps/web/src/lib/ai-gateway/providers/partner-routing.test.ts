import { describe, expect, it } from '@jest/globals';

import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import { selectPercentageRoutedPartnerProvider } from '@/lib/ai-gateway/providers/partner-routing';
import PROVIDERS from '@/lib/ai-gateway/providers/provider-definitions';
import type { RuntimeGatewayRoutingConfig } from '@/lib/ai-gateway/providers/routing-config';

function request(
  kind: GatewayRequest['kind'] = 'messages',
  provider?: GatewayRequest['body']['provider']
): GatewayRequest {
  if (kind === 'responses') {
    return { kind, body: { model: 'model', input: 'hello', provider } };
  }
  return {
    kind,
    body: {
      model: 'model',
      max_tokens: 1_024,
      messages: [{ role: 'user', content: 'hello' }],
      provider,
    },
  };
}

describe('getPercentageRoutedPartnerProvider', () => {
  const routingConfig: RuntimeGatewayRoutingConfig = {
    vercelPaid: 50,
    vercelFree: 50,
    vercelOptOutModels: new Set(),
    friendli: 100,
    perplexity: 100,
  };

  it.each([
    ['z-ai/glm-5.2', PROVIDERS.FRIENDLI_GLM],
    ['moonshotai/kimi-k3', PROVIDERS.PERPLEXITY_KIMI],
  ])('routes exact model %s', (model, expectedProvider) => {
    expect(selectPercentageRoutedPartnerProvider(model, request(), 'user-id', routingConfig)).toBe(
      expectedProvider
    );
  });

  it('routes Messages requests', () => {
    expect(
      selectPercentageRoutedPartnerProvider(
        'z-ai/glm-5.2',
        request('messages'),
        'user-id',
        routingConfig
      )
    ).toBe(PROVIDERS.FRIENDLI_GLM);
  });

  it.each(['chat_completions', 'responses'] as const)(
    'does not route unsupported %s requests',
    kind => {
      expect(
        selectPercentageRoutedPartnerProvider(
          'z-ai/glm-5.2',
          request(kind),
          'user-id',
          routingConfig
        )
      ).toBeNull();
    }
  );

  it('allows an empty provider object', () => {
    expect(
      selectPercentageRoutedPartnerProvider(
        'z-ai/glm-5.2',
        request('messages', {}),
        'user-id',
        routingConfig
      )
    ).toBe(PROVIDERS.FRIENDLI_GLM);
  });

  it('does not route requests with customized provider options', () => {
    expect(
      selectPercentageRoutedPartnerProvider(
        'z-ai/glm-5.2',
        request('messages', { only: ['friendli'] }),
        'user-id',
        routingConfig
      )
    ).toBeNull();
  });

  it.each(['z-ai/glm-5.2-fast', 'moonshotai/kimi-k3-fast', 'zai/glm-5.2'])(
    'does not route non-exact model %s',
    model => {
      expect(
        selectPercentageRoutedPartnerProvider(model, request(), 'user-id', routingConfig)
      ).toBeNull();
    }
  );

  it('does not route at zero percent', () => {
    const disabledConfig: RuntimeGatewayRoutingConfig = {
      ...routingConfig,
      friendli: 0,
      perplexity: 0,
    };

    expect(
      selectPercentageRoutedPartnerProvider('z-ai/glm-5.2', request(), 'user-id', disabledConfig)
    ).toBeNull();
  });
});
