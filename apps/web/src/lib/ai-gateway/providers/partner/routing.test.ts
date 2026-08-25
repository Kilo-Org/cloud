import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';

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
  selectPercentageRoutedPartnerProvider,
  type PercentageRoutedPartnerInput,
} from '@/lib/ai-gateway/providers/partner/routing';
import type { RuntimeGatewayRoutingConfig } from '@/lib/ai-gateway/providers/routing-config';

const originalFriendliApiKey = FRIENDLI_GLM_PROVIDER.apiKey;
const originalPerplexityApiKey = PERPLEXITY_KIMI_PROVIDER.apiKey;

function setApiKey(
  provider: typeof FRIENDLI_GLM_PROVIDER | typeof PERPLEXITY_KIMI_PROVIDER,
  value: string
) {
  Object.defineProperty(provider, 'apiKey', {
    value,
    configurable: true,
    enumerable: true,
    writable: true,
  });
}

beforeEach(() => {
  setApiKey(FRIENDLI_GLM_PROVIDER, 'test-friendli-key');
  setApiKey(PERPLEXITY_KIMI_PROVIDER, 'test-perplexity-key');
});

afterAll(() => {
  setApiKey(FRIENDLI_GLM_PROVIDER, originalFriendliApiKey);
  setApiKey(PERPLEXITY_KIMI_PROVIDER, originalPerplexityApiKey);
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
  friendli: 100,
  perplexity: 100,
};

const defaultInput = {
  requestedModel: FRIENDLI_GLM_PUBLIC_ID,
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
    [FRIENDLI_GLM_PUBLIC_ID, FRIENDLI_GLM_PROVIDER],
    [PERPLEXITY_KIMI_PUBLIC_ID, PERPLEXITY_KIMI_PROVIDER],
  ])('routes exact model %s', (model, expectedProvider) => {
    expect(selectPartner({ requestedModel: model })).toBe(expectedProvider);
  });

  it('routes chat completions requests', () => {
    expect(selectPartner()).toBe(FRIENDLI_GLM_PROVIDER);
  });

  it.each(['messages', 'responses'] as const)('does not route untested %s requests', kind => {
    expect(selectPartner({ request: request(kind) })).toBeNull();
  });

  it('allows an empty provider object', () => {
    expect(selectPartner({ request: request('chat_completions', {}) })).toBe(FRIENDLI_GLM_PROVIDER);
  });

  it.each([
    [FRIENDLI_GLM_PUBLIC_ID, 'friendli', FRIENDLI_GLM_PROVIDER],
    [PERPLEXITY_KIMI_PUBLIC_ID, 'perplexity', PERPLEXITY_KIMI_PROVIDER],
  ])('honors provider filters for %s', (requestedModel, providerId, expectedProvider) => {
    expect(
      selectPartner({
        requestedModel,
        request: request('chat_completions', { only: [providerId] }),
      })
    ).toBe(expectedProvider);
    expect(
      selectPartner({
        requestedModel,
        request: request('chat_completions', { ignore: ['openai'] }),
      })
    ).toBe(expectedProvider);
    expect(
      selectPartner({ requestedModel, request: request('chat_completions', { only: ['openai'] }) })
    ).toBeNull();
    expect(
      selectPartner({
        requestedModel,
        request: request('chat_completions', { ignore: [providerId] }),
      })
    ).toBeNull();
  });

  it.each([
    [FRIENDLI_GLM_PUBLIC_ID, { data_collection: 'deny' } as const, FRIENDLI_GLM_PROVIDER],
    [PERPLEXITY_KIMI_PUBLIC_ID, { zdr: true } as const, PERPLEXITY_KIMI_PROVIDER],
  ])('routes ZDR model %s with data policy options', (requestedModel, provider, expected) => {
    expect(selectPartner({ requestedModel, request: request('chat_completions', provider) })).toBe(
      expected
    );
  });

  it.each(['openrouter', 'vercel'] as const)(
    'routes from managed provider %s',
    sourceProviderId => {
      expect(selectPartner({ sourceProviderId })).toBe(FRIENDLI_GLM_PROVIDER);
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

  it('does not route without a non-empty partner API key', () => {
    setApiKey(FRIENDLI_GLM_PROVIDER, '  ');

    expect(selectPartner()).toBeNull();
  });

  it.each([`${FRIENDLI_GLM_PUBLIC_ID}-fast`, `${PERPLEXITY_KIMI_PUBLIC_ID}-fast`, 'zai/glm-5.2'])(
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
