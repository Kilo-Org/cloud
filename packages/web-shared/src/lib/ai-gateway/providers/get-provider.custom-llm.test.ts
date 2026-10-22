import { beforeEach, describe, expect, it } from '@jest/globals';
import type { User } from '@kilocode/db/schema';
import type { CustomLlmCredentials, CustomLlmDefinition } from '@kilocode/db/schema-types';
import { encryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import { getProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/get-provider';
import { BYOK_ENCRYPTION_KEY } from '@kilocode/web-shared/lib/config.server';
import { cleanupDbForTest } from '@kilocode/web-shared/lib/drizzle';
import { insertCustomLlmForTest } from '@kilocode/web-shared/tests/helpers/custom-llm.helper';
import {
  createAnonymousContext,
  type AnonymousUserContext,
} from '@kilocode/web-shared/lib/anonymous';

const ORG_ID = '00000000-0000-4000-8000-000000000001';
const PUBLIC_ID = 'acme/secure-proxy-model';

const definition: CustomLlmDefinition = {
  internal_id: 'upstream-model',
  display_name: 'Secure proxy model',
  context_length: 128_000,
  max_completion_tokens: 4096,
  base_url: 'https://secure-proxy.example.com/api/proxy',
  disable_url_suffix: true,
  organization_ids: [ORG_ID],
};

async function insertCustomLlm(credentials: CustomLlmCredentials) {
  await insertCustomLlmForTest(
    PUBLIC_ID,
    definition,
    encryptApiKey(JSON.stringify(credentials), BYOK_ENCRYPTION_KEY)
  );
}

function resolveProvider(
  user: User | AnonymousUserContext = { id: 'user-id' } as User,
  organizationId: string | null = ORG_ID
) {
  return getProvider({
    requestedModel: PUBLIC_ID,
    request: {
      kind: 'chat_completions',
      body: { model: PUBLIC_ID, messages: [{ role: 'user', content: 'hi' }] },
    },
    user,
    organizationId: organizationId ?? undefined,
  });
}

describe('getProvider custom LLM credentials', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  it('routes secure_proxy credentials through the proxy in base_url', async () => {
    await insertCustomLlm({
      type: 'secure_proxy',
      proxy_secret: 'proxy-secret',
      config: {
        url: 'https://llm.example.com/v1/chat/completions',
        extra_headers: { Authorization: 'Bearer upstream-key' },
      },
    });

    const result = await resolveProvider();

    expect(result).toMatchObject({
      kind: 'provider',
      bypassAccessCheck: true,
      isFree: true,
      provider: {
        id: 'custom',
        apiUrl: 'https://llm.example.com/v1/chat/completions',
        disableUrlSuffix: true,
        apiKey: 'proxy-secret',
        secureProxy: {
          url: 'https://secure-proxy.example.com/api/proxy',
          upstreamAuthHeaders: { Authorization: 'Bearer upstream-key' },
        },
      },
    });
  });

  it('sends API key credentials straight to base_url', async () => {
    await insertCustomLlm({ type: 'x-api-key', api_key: 'upstream-key' });

    const result = await resolveProvider();

    expect(result).toMatchObject({
      kind: 'provider',
      isFree: true,
      provider: {
        apiUrl: 'https://secure-proxy.example.com/api/proxy',
        apiKey: 'upstream-key',
        apiKeyHeader: 'x-api-key',
      },
    });
    if (result.kind !== 'provider') throw new Error('expected a provider');
    expect(result.provider.secureProxy).toBeUndefined();
  });

  it('signs aws_bedrock credentials with SigV4 instead of sending an API key', async () => {
    const credentials = {
      type: 'aws_bedrock',
      region: 'us-east-1',
      access_key_id: 'AKIDEXAMPLE',
      secret_access_key: 'secret-access-key',
    } as const;
    await insertCustomLlm(credentials);

    const result = await resolveProvider();

    expect(result).toMatchObject({
      kind: 'provider',
      bypassAccessCheck: true,
      provider: {
        apiUrl: 'https://secure-proxy.example.com/api/proxy',
        apiKey: '',
        apiKeyHeader: null,
        awsBedrock: credentials,
      },
    });
    if (result.kind !== 'provider') throw new Error('expected a provider');
    expect(result.provider.secureProxy).toBeUndefined();
  });

  it.each([
    ['another organization', { id: 'user-id' } as User, '00000000-0000-4000-8000-000000000002'],
    ['a personal account', { id: 'user-id' } as User, null],
    ['an anonymous caller', createAnonymousContext('127.0.0.1'), null],
  ])(
    'fails closed for %s instead of falling back to another upstream',
    async (_caller, user, orgId) => {
      await insertCustomLlm({ type: 'api_key', api_key: 'upstream-key' });

      await expect(resolveProvider(user, orgId)).resolves.toEqual({
        kind: 'custom-llm-unavailable',
      });
    }
  );

  it('fails closed when the custom LLM has no usable credentials', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await insertCustomLlmForTest(PUBLIC_ID, definition, null);

    await expect(resolveProvider()).resolves.toEqual({ kind: 'custom-llm-unavailable' });
  });
});
