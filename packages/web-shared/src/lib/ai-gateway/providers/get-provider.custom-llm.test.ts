import { beforeEach, describe, expect, it } from '@jest/globals';
import type { User } from '@kilocode/db/schema';
import type { CustomLlmCredentials, CustomLlmDefinition } from '@kilocode/db/schema-types';
import { encryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import { getProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/get-provider';
import { BYOK_ENCRYPTION_KEY } from '@kilocode/web-shared/lib/config.server';
import { cleanupDbForTest } from '@kilocode/web-shared/lib/drizzle';
import { insertCustomLlmForTest } from '@kilocode/web-shared/tests/helpers/custom-llm.helper';

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

function resolveProvider() {
  return getProvider({
    requestedModel: PUBLIC_ID,
    request: {
      kind: 'chat_completions',
      body: { model: PUBLIC_ID, messages: [{ role: 'user', content: 'hi' }] },
    },
    user: { id: 'user-id' } as User,
    organizationId: ORG_ID,
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
      provider: {
        apiUrl: 'https://secure-proxy.example.com/api/proxy',
        apiKey: 'upstream-key',
        apiKeyHeader: 'x-api-key',
      },
    });
    if (result.kind !== 'provider') throw new Error('expected a provider');
    expect(result.provider.secureProxy).toBeUndefined();
  });
});
