import { afterAll, afterEach, beforeAll, describe, expect, test } from '@jest/globals';
import { getProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/get-provider';
import { encryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@kilocode/web-shared/lib/config.server';
import { createAnonymousContext } from '@kilocode/web-shared/lib/anonymous';
import { kiloExclusiveModels } from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import { resetCustomLlmCacheForTest } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import type { User } from '@kilocode/db/schema';
import {
  customLlmDefinition,
  deleteCustomLlmForTest,
  insertCustomLlmForTest,
  publicCustomLlmDefinition,
} from '@kilocode/web-shared/tests/helpers/custom-llm.helper';

const ORG_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_ORG_ID = '00000000-0000-4000-8000-000000000002';
const user = { id: 'user-id' } as User;
const encryptedApiKey = encryptApiKey(
  JSON.stringify({ type: 'api_key', api_key: 'sk-upstream' }),
  BYOK_ENCRYPTION_KEY
);
const shadowedExclusiveId =
  kiloExclusiveModels.find(model => !model.public_id.includes(':'))?.public_id ?? '';

function providerInput(
  requestedModel: string,
  caller: User | ReturnType<typeof createAnonymousContext>,
  organizationId: string | undefined
) {
  return {
    requestedModel,
    request: {
      kind: 'chat_completions',
      body: { model: requestedModel, messages: [] },
    } satisfies GatewayRequest,
    user: caller,
    organizationId,
  };
}

describe('getProvider with public custom LLMs', () => {
  beforeAll(async () => {
    await insertCustomLlmForTest(
      'acme/public-model',
      publicCustomLlmDefinition(['acme']),
      encryptedApiKey
    );
    await insertCustomLlmForTest(
      shadowedExclusiveId,
      customLlmDefinition({ organization_ids: [ORG_ID] }),
      encryptedApiKey
    );
  });

  afterAll(async () => {
    await deleteCustomLlmForTest('acme/public-model');
    await deleteCustomLlmForTest(shadowedExclusiveId);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    resetCustomLlmCacheForTest();
  });

  test('routes a public custom LLM for an anonymous caller through policy checks', async () => {
    const result = await getProvider(
      providerInput('acme/public-model', createAnonymousContext('127.0.0.1'), undefined)
    );

    expect(result).toMatchObject({
      kind: 'provider',
      provider: { id: 'custom', apiUrl: 'https://upstream.example.com/v1', apiKey: 'sk-upstream' },
      bypassAccessCheck: false,
    });
  });

  test('takes precedence over a Kilo-exclusive model with the same id', async () => {
    await expect(
      getProvider(providerInput(shadowedExclusiveId, user, ORG_ID))
    ).resolves.toMatchObject({ kind: 'provider', provider: { id: 'custom' } });
    await expect(
      getProvider(providerInput(shadowedExclusiveId, user, OTHER_ORG_ID))
    ).resolves.toEqual({ kind: 'custom-llm-unavailable' });
  });

  test('refuses a Kilo-exclusive id while the custom LLM catalog cannot be read', async () => {
    resetCustomLlmCacheForTest();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(readDb, 'select').mockImplementationOnce(() => {
      throw new Error('database unavailable');
    });

    await expect(getProvider(providerInput(shadowedExclusiveId, user, ORG_ID))).resolves.toEqual({
      kind: 'custom-llm-temporarily-unavailable',
    });
  });
});
