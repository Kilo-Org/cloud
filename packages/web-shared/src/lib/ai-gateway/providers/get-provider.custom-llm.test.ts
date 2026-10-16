import { beforeEach, describe, expect, it } from '@jest/globals';
import { custom_llm2, type User } from '@kilocode/db/schema';
import type {
  CustomLlmCredentials,
  CustomLlmDefinition,
  EncryptedData,
} from '@kilocode/db/schema-types';
import { encryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import { getProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/get-provider';
import { BYOK_ENCRYPTION_KEY } from '@kilocode/web-shared/lib/config.server';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';

jest.mock('@kilocode/web-shared/lib/ai-gateway/custom-llm/google-service-account', () => ({
  getGoogleServiceAccountAccessToken: jest.fn().mockRejectedValue(new Error('network error')),
}));

const ORG_ID = '00000000-0000-4000-8000-000000000001';
const PUBLIC_ID = 'kilo-internal/secure-proxy-model';

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
  await insertEncryptedCustomLlm(encryptApiKey(JSON.stringify(credentials), BYOK_ENCRYPTION_KEY));
}

async function insertEncryptedCustomLlm(encryptedApiKey: EncryptedData) {
  await db.insert(custom_llm2).values({
    public_id: PUBLIC_ID,
    definition,
    encrypted_api_key: encryptedApiKey,
  });
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
    taskId: undefined,
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

  it('does not throw when the stored credentials cannot be decrypted', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const encrypted = encryptApiKey(
      JSON.stringify({ type: 'api_key', api_key: 'upstream-key' }),
      BYOK_ENCRYPTION_KEY
    );
    await insertEncryptedCustomLlm({ ...encrypted, authTag: Buffer.alloc(16).toString('base64') });

    const result = await resolveProvider();

    expect(result).toMatchObject({ kind: 'provider' });
    if (result.kind !== 'provider') throw new Error('expected a provider');
    expect(result.provider.id).not.toBe('custom');
  });

  it('reports a failed service account token exchange as temporarily unavailable', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await insertCustomLlm({
      type: 'service_account',
      project_id: 'project',
      private_key_id: 'key-id',
      private_key: 'private-key',
      client_email: 'service@project.iam.gserviceaccount.com',
      client_id: 'client-id',
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
      auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
      client_x509_cert_url: 'https://www.googleapis.com/robot/v1/metadata/x509/service',
    });

    await expect(resolveProvider()).resolves.toEqual({
      kind: 'custom-llm-temporarily-unavailable',
    });
  });
});
