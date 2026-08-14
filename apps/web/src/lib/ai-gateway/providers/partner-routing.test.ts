import { describe, expect, it } from '@jest/globals';

import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import {
  selectPercentageRoutedPartnerProvider,
  type PercentageRoutedPartnerInput,
} from '@/lib/ai-gateway/providers/partner-routing';
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

const routingConfig: RuntimeGatewayRoutingConfig = {
  vercelPaid: 50,
  vercelFree: 50,
  vercelOptOutModels: new Set(),
  friendli: 100,
  perplexity: 100,
};

const defaultInput = {
  requestedModel: 'z-ai/glm-5.2',
  request: request(),
  randomSeed: 'user-id',
  sourceProviderId: 'openrouter',
  hasUserByok: false,
} satisfies PercentageRoutedPartnerInput;

function selectPartner(
  overrides: Partial<PercentageRoutedPartnerInput> = {},
  config = routingConfig
) {
  return selectPercentageRoutedPartnerProvider({ ...defaultInput, ...overrides }, config);
}

describe('getPercentageRoutedPartnerProvider', () => {
  it.each([
    ['z-ai/glm-5.2', PROVIDERS.FRIENDLI_GLM],
    ['moonshotai/kimi-k3', PROVIDERS.PERPLEXITY_KIMI],
  ])('routes exact model %s', (model, expectedProvider) => {
    expect(selectPartner({ requestedModel: model })).toBe(expectedProvider);
  });

  it('routes Messages requests', () => {
    expect(selectPartner({ request: request('messages') })).toBe(PROVIDERS.FRIENDLI_GLM);
  });

  it.each(['chat_completions', 'responses'] as const)(
    'does not route unsupported %s requests',
    kind => {
      expect(selectPartner({ request: request(kind) })).toBeNull();
    }
  );

  it('allows an empty provider object', () => {
    expect(selectPartner({ request: request('messages', {}) })).toBe(PROVIDERS.FRIENDLI_GLM);
  });

  it('does not route requests with customized provider options', () => {
    expect(selectPartner({ request: request('messages', { only: ['friendli'] }) })).toBeNull();
  });

  it.each(['openrouter', 'vercel'] as const)(
    'routes from managed provider %s',
    sourceProviderId => {
      expect(selectPartner({ sourceProviderId })).toBe(PROVIDERS.FRIENDLI_GLM);
    }
  );

  it.each(['friendli', 'custom', 'direct-byok'] as const)(
    'does not override provider %s',
    sourceProviderId => {
      expect(selectPartner({ sourceProviderId })).toBeNull();
    }
  );

  it('does not override user BYOK', () => {
    expect(selectPartner({ sourceProviderId: 'vercel', hasUserByok: true })).toBeNull();
  });

  it.each(['z-ai/glm-5.2-fast', 'moonshotai/kimi-k3-fast', 'zai/glm-5.2'])(
    'does not route non-exact model %s',
    model => {
      expect(selectPartner({ requestedModel: model })).toBeNull();
    }
  );

  it('does not route at zero percent', () => {
    const disabledConfig: RuntimeGatewayRoutingConfig = {
      ...routingConfig,
      friendli: 0,
      perplexity: 0,
    };

    expect(selectPartner({}, disabledConfig)).toBeNull();
  });
});
