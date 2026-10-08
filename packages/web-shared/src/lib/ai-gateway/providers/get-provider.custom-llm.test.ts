import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { getProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/get-provider';
import { OPENROUTER } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import { encryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@kilocode/web-shared/lib/config.server';
import { createAnonymousContext } from '@kilocode/web-shared/lib/anonymous';
import { kiloExclusiveModels } from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import type { User } from '@kilocode/db/schema';
import {
  deleteCustomLlmForTest,
  insertCustomLlmForTest,
  privateCustomLlmDefinition,
  publicCustomLlmDefinition,
} from '@kilocode/web-shared/tests/helpers/custom-llm.helper';

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/direct-byok', () => ({
  getDirectByokModel: jest.fn().mockResolvedValue({ provider: null, model: null }),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/byok', () => ({
  getModelUserByokProviders: jest.fn().mockResolvedValue([]),
  getBYOKforUser: jest.fn(),
  getBYOKforOrganization: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/vercel', () => ({
  shouldRouteToVercel: jest.fn().mockResolvedValue(false),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/routing', () => ({
  checkOpenAiChatGptByok: jest.fn().mockResolvedValue(null),
}));

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
    taskId: undefined,
  };
}

describe('getProvider with custom LLMs', () => {
  beforeAll(async () => {
    await insertCustomLlmForTest(
      'acme/public-model',
      publicCustomLlmDefinition(['acme']),
      encryptedApiKey
    );
    await insertCustomLlmForTest(
      'acme/private-model',
      privateCustomLlmDefinition({ organization_ids: [ORG_ID] }),
      encryptedApiKey
    );
    await insertCustomLlmForTest('acme/no-credentials', publicCustomLlmDefinition(['acme']), null);
    await insertCustomLlmForTest(
      shadowedExclusiveId,
      privateCustomLlmDefinition({ organization_ids: [ORG_ID] }),
      encryptedApiKey
    );
  });

  afterAll(async () => {
    for (const publicId of [
      'acme/public-model',
      'acme/private-model',
      'acme/no-credentials',
      shadowedExclusiveId,
    ]) {
      await deleteCustomLlmForTest(publicId);
    }
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

  test('routes a private custom LLM for an eligible organization member', async () => {
    const result = await getProvider(providerInput('acme/private-model', user, ORG_ID));

    expect(result).toMatchObject({
      kind: 'provider',
      provider: { id: 'custom' },
      bypassAccessCheck: true,
    });
  });

  test.each([
    ['another organization', user, OTHER_ORG_ID],
    ['a personal account', user, undefined],
    ['an anonymous caller', createAnonymousContext('127.0.0.1'), undefined],
  ])('does not fall back to another upstream for %s', async (_caller, caller, organizationId) => {
    const result = await getProvider(providerInput('acme/private-model', caller, organizationId));

    expect(result).toEqual({ kind: 'custom-llm-unavailable' });
  });

  test('takes precedence over a Kilo-exclusive model with the same id', async () => {
    await expect(
      getProvider(providerInput(shadowedExclusiveId, user, ORG_ID))
    ).resolves.toMatchObject({ kind: 'provider', provider: { id: 'custom' } });
    await expect(
      getProvider(providerInput(shadowedExclusiveId, user, OTHER_ORG_ID))
    ).resolves.toEqual({ kind: 'custom-llm-unavailable' });
  });

  test('fails a custom LLM without credentials instead of falling back', async () => {
    const result = await getProvider(providerInput('acme/no-credentials', user, undefined));

    expect(result).toEqual({ kind: 'custom-llm-unavailable' });
  });

  test('routes ids without a custom LLM to the regular gateway', async () => {
    const result = await getProvider(providerInput('acme/unknown-model', user, ORG_ID));

    expect(result).toMatchObject({ kind: 'provider', provider: OPENROUTER });
  });
});
