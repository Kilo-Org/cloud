import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';

import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import { PERPLEXITY_KIMI_PUBLIC_ID } from '@/lib/ai-gateway/providers/partner/constants';
import { PERPLEXITY_KIMI_PROVIDER } from '@/lib/ai-gateway/providers/partner/providers';
import {
  selectPercentageRoutedPartnerProvider,
  type PercentageRoutedPartnerInput,
} from '@/lib/ai-gateway/providers/partner/routing';
import type { RuntimeGatewayRoutingConfig } from '@/lib/ai-gateway/providers/routing-config';

const originalPerplexityApiKey = PERPLEXITY_KIMI_PROVIDER.apiKey;

function setApiKey(value: string) {
  Object.defineProperty(PERPLEXITY_KIMI_PROVIDER, 'apiKey', {
    value,
    configurable: true,
    enumerable: true,
    writable: true,
  });
}

beforeEach(() => {
  setApiKey('test-perplexity-key');
});

afterAll(() => {
  setApiKey(originalPerplexityApiKey);
});

function request(
  kind: GatewayRequest['kind'] = 'chat_completions',
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
  perplexity: 100,
};

const defaultInput = {
  requestedModel: PERPLEXITY_KIMI_PUBLIC_ID,
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

describe('selectPercentageRoutedPartnerProvider', () => {
  it('routes the exact Kimi model for chat completions requests', () => {
    expect(selectPartner()).toBe(PERPLEXITY_KIMI_PROVIDER);
  });

  it.each(['openrouter', 'vercel'] as const)(
    'does not route GLM 5.2 from %s to a direct partner',
    sourceProviderId => {
      expect(selectPartner({ requestedModel: 'z-ai/glm-5.2', sourceProviderId })).toBeNull();
    }
  );

  it.each(['messages', 'responses'] as const)('does not route untested %s requests', kind => {
    expect(selectPartner({ request: request(kind) })).toBeNull();
  });

  it('allows an empty provider object', () => {
    expect(selectPartner({ request: request('chat_completions', {}) })).toBe(
      PERPLEXITY_KIMI_PROVIDER
    );
  });

  it('honors provider filters', () => {
    expect(selectPartner({ request: request('chat_completions', { only: ['perplexity'] }) })).toBe(
      PERPLEXITY_KIMI_PROVIDER
    );
    expect(selectPartner({ request: request('chat_completions', { ignore: ['openai'] }) })).toBe(
      PERPLEXITY_KIMI_PROVIDER
    );
    expect(
      selectPartner({ request: request('chat_completions', { only: ['openai'] }) })
    ).toBeNull();
    expect(
      selectPartner({ request: request('chat_completions', { ignore: ['perplexity'] }) })
    ).toBeNull();
  });

  it.each([{ data_collection: 'deny' } as const, { zdr: true } as const])(
    'routes the ZDR model with data policy options %p',
    provider => {
      expect(selectPartner({ request: request('chat_completions', provider) })).toBe(
        PERPLEXITY_KIMI_PROVIDER
      );
    }
  );

  it.each(['openrouter', 'vercel'] as const)(
    'routes from managed provider %s',
    sourceProviderId => {
      expect(selectPartner({ sourceProviderId })).toBe(PERPLEXITY_KIMI_PROVIDER);
    }
  );

  it.each(['perplexity', 'custom', 'direct-byok'] as const)(
    'does not override provider %s',
    sourceProviderId => {
      expect(selectPartner({ sourceProviderId })).toBeNull();
    }
  );

  it.each(['openrouter', 'vercel'] as const)(
    'does not override user BYOK from %s',
    sourceProviderId => {
      expect(selectPartner({ sourceProviderId, hasUserByok: true })).toBeNull();
    }
  );

  it.each(['', '  '])('does not route with an empty partner API key %p', apiKey => {
    setApiKey(apiKey);

    expect(selectPartner()).toBeNull();
  });

  it.each([`${PERPLEXITY_KIMI_PUBLIC_ID}-fast`, 'perplexity/kimi-k3'])(
    'does not route non-exact model %s',
    model => {
      expect(selectPartner({ requestedModel: model })).toBeNull();
    }
  );

  it('does not route at zero percent', () => {
    const disabledConfig: RuntimeGatewayRoutingConfig = {
      ...routingConfig,
      perplexity: 0,
    };

    expect(selectPartner({}, disabledConfig)).toBeNull();
  });
});
