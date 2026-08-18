import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';

import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import {
  selectPercentageRoutedPartnerProvider,
  type PercentageRoutedPartnerInput,
} from '@/lib/ai-gateway/providers/partner-routing';
import PROVIDERS from '@/lib/ai-gateway/providers/provider-definitions';
import type { RuntimeGatewayRoutingConfig } from '@/lib/ai-gateway/providers/routing-config';
import { PERPLEXITY_KIMI_PUBLIC_ID } from '@/lib/ai-gateway/providers/moonshotai';
import { FRIENDLI_GLM_PUBLIC_ID } from '@/lib/ai-gateway/providers/zai';

const originalFriendliApiKey = PROVIDERS.FRIENDLI_GLM.apiKey;
const originalPerplexityApiKey = PROVIDERS.PERPLEXITY_KIMI.apiKey;

function setApiKey(
  provider: typeof PROVIDERS.FRIENDLI_GLM | typeof PROVIDERS.PERPLEXITY_KIMI,
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
  setApiKey(PROVIDERS.FRIENDLI_GLM, 'test-friendli-key');
  setApiKey(PROVIDERS.PERPLEXITY_KIMI, 'test-perplexity-key');
});

afterAll(() => {
  setApiKey(PROVIDERS.FRIENDLI_GLM, originalFriendliApiKey);
  setApiKey(PROVIDERS.PERPLEXITY_KIMI, originalPerplexityApiKey);
});

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
    [FRIENDLI_GLM_PUBLIC_ID, PROVIDERS.FRIENDLI_GLM],
    [PERPLEXITY_KIMI_PUBLIC_ID, PROVIDERS.PERPLEXITY_KIMI],
  ])('routes exact model %s', (model, expectedProvider) => {
    expect(selectPartner({ requestedModel: model })).toBe(expectedProvider);
  });

  it.each(['chat_completions', 'messages', 'responses'] as const)('routes %s requests', kind => {
    expect(selectPartner({ request: request(kind) })).toBe(PROVIDERS.FRIENDLI_GLM);
  });

  it('allows an empty provider object', () => {
    expect(selectPartner({ request: request('messages', {}) })).toBe(PROVIDERS.FRIENDLI_GLM);
  });

  it.each([
    [FRIENDLI_GLM_PUBLIC_ID, 'friendli', PROVIDERS.FRIENDLI_GLM],
    [PERPLEXITY_KIMI_PUBLIC_ID, 'perplexity', PROVIDERS.PERPLEXITY_KIMI],
  ])('honors provider filters for %s', (requestedModel, providerId, expectedProvider) => {
    expect(
      selectPartner({ requestedModel, request: request('messages', { only: [providerId] }) })
    ).toBe(expectedProvider);
    expect(
      selectPartner({ requestedModel, request: request('messages', { ignore: ['openai'] }) })
    ).toBe(expectedProvider);
    expect(
      selectPartner({ requestedModel, request: request('messages', { only: ['openai'] }) })
    ).toBeNull();
    expect(
      selectPartner({ requestedModel, request: request('messages', { ignore: [providerId] }) })
    ).toBeNull();
  });

  it.each([
    [FRIENDLI_GLM_PUBLIC_ID, { data_collection: 'deny' } as const, PROVIDERS.FRIENDLI_GLM],
    [PERPLEXITY_KIMI_PUBLIC_ID, { zdr: true } as const, PROVIDERS.PERPLEXITY_KIMI],
  ])('routes ZDR model %s with data policy options', (requestedModel, provider, expected) => {
    expect(selectPartner({ requestedModel, request: request('messages', provider) })).toBe(
      expected
    );
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

  it('does not route without a non-empty partner API key', () => {
    setApiKey(PROVIDERS.FRIENDLI_GLM, '  ');

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
