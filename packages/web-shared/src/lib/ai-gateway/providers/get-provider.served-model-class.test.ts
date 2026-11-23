import { describe, expect, test } from '@jest/globals';
import { getProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/get-provider';
import { getProviderInput } from '@kilocode/web-shared/tests/helpers/get-provider-input.helper';
import { onlyRoute } from '@kilocode/web-shared/tests/helpers/get-provider-result.helper';
import type * as byokModule from '@kilocode/web-shared/lib/ai-gateway/byok';
import type * as directByokModule from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import type { User } from '@kilocode/db/schema';

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/direct-byok', () => {
  const actual = jest.requireActual<typeof directByokModule>(
    '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok'
  );
  return {
    getDirectByokModel: jest.fn().mockResolvedValue(null),
    findDirectByokCatalogModels: jest.fn().mockResolvedValue([]),
    getDirectByokCatalogModelId: jest.fn().mockResolvedValue(null),
    getDirectByokModelChatApis: actual.getDirectByokModelChatApis,
    getDirectByokPolicyProviderId: actual.getDirectByokPolicyProviderId,
    supportsCatalogMode: jest.fn(() => true),
  };
});
jest.mock('@kilocode/web-shared/lib/ai-gateway/byok', () => ({
  byokOwner: (userId: string, organizationId: string | undefined) =>
    organizationId ? { type: 'organization', id: organizationId } : { type: 'user', id: userId },
  getModelInferenceUserByokProviders: jest.fn().mockResolvedValue([]),
  getModelGatewayUserByokProviders: jest.fn().mockResolvedValue([]),
  isGatewayUserByokEligibleModel: (modelId: string) =>
    jest
      .requireActual<typeof byokModule>('@kilocode/web-shared/lib/ai-gateway/byok')
      .isGatewayUserByokEligibleModel(modelId),
  getByokCredentials: jest.fn().mockResolvedValue([]),
  getStoredByokKeys: jest.fn(async () => ({
    keys: [],
    decrypt: async () => {
      throw new Error('no stored key');
    },
  })),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/vercel', () => ({
  shouldRouteToVercel: jest.fn().mockResolvedValue(false),
  canRouteToVercel: jest.fn().mockResolvedValue(true),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/store', () => ({
  getOpenAiChatGptStoredConnection: jest.fn().mockResolvedValue(null),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/served-models', () => ({
  isOpenAiModelServed: jest.fn().mockResolvedValue(true),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/refresh', () => ({
  resolveOpenAiChatGptAccessToken: jest.fn().mockResolvedValue({ kind: 'no_connection' }),
  OPENAI_CHATGPT_RECONNECT_MESSAGE: 'Your ChatGPT connection has expired. Reconnect to continue.',
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache'
  ),
  resolveOpenRouterModelAlias: jest.fn(async (modelId: string) => {
    if (modelId === '~vendor/latest') return 'vendor/model:free';
    if (modelId === '~vendor/paid-latest') return 'vendor/paid-model';
    return modelId;
  }),
}));

const user = { id: 'user-id' } as User;

function providerInput(requestedModel: string) {
  return {
    requestedModel,
    request: {
      kind: 'chat_completions',
      body: { model: requestedModel, messages: [] },
    } satisfies GatewayRequest,
    user,
    organizationId: undefined,
  };
}

describe('getProvider served model class', () => {
  test('classifies a latest alias by the free catalog model it serves', async () => {
    expect(
      await onlyRoute(await getProvider(getProviderInput(providerInput('~vendor/latest'))))
    ).toMatchObject({ isFree: true });
  });

  test('classifies a latest alias by the paid catalog model it serves', async () => {
    expect(
      await onlyRoute(await getProvider(getProviderInput(providerInput('~vendor/paid-latest'))))
    ).toMatchObject({ isFree: false });
  });

  test('classifies a free catalog model requested directly', async () => {
    expect(
      await onlyRoute(await getProvider(getProviderInput(providerInput('vendor/model:free'))))
    ).toMatchObject({ isFree: true });
  });
});
