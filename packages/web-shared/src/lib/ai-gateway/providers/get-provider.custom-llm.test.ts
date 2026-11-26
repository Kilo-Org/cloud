import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { User } from '@kilocode/db/schema';
import type { CustomLlmCredentials, CustomLlmDefinition } from '@kilocode/db/schema-types';
import { getProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/get-provider';
import { getProviderInput } from '@kilocode/web-shared/tests/helpers/get-provider-input.helper';
import { onlyRoute } from '@kilocode/web-shared/tests/helpers/get-provider-result.helper';
import { cleanupDbForTest } from '@kilocode/web-shared/lib/drizzle';
import {
  insertCustomLlmForTest,
  testCustomLlmCredentialsEnvelope,
} from '@kilocode/web-shared/tests/helpers/custom-llm.helper';
import {
  testByokEnvelope,
  useFakeByokKms,
} from '@kilocode/web-shared/tests/helpers/byok-kms.helper';
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
    testCustomLlmCredentialsEnvelope(credentials)
  );
}

function resolveProvider(
  user: User | AnonymousUserContext = { id: 'user-id' } as User,
  organizationId: string | null = ORG_ID
) {
  return getProvider(
    getProviderInput({
      requestedModel: PUBLIC_ID,
      request: {
        kind: 'chat_completions',
        body: { model: PUBLIC_ID, messages: [{ role: 'user', content: 'hi' }] },
      },
      user,
      organizationId: organizationId ?? undefined,
    })
  );
}

const fakeKms = useFakeByokKms();

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

    const result = await onlyRoute(await resolveProvider());

    expect(result).toMatchObject({
      bypassAccessCheck: true,
      isFree: false,
      provider: {
        type: 'custom',
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

    const result = await onlyRoute(await resolveProvider());

    expect(result).toMatchObject({
      isFree: false,
      provider: {
        apiUrl: 'https://secure-proxy.example.com/api/proxy',
        apiKey: 'upstream-key',
        apiKeyHeader: 'x-api-key',
      },
    });
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

    const result = await onlyRoute(await resolveProvider());

    expect(result).toMatchObject({
      bypassAccessCheck: true,
      provider: {
        apiUrl: 'https://secure-proxy.example.com/api/proxy',
        apiKey: '',
        apiKeyHeader: null,
        awsBedrock: credentials,
      },
    });
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

  describe('when the credentials are unusable', () => {
    afterEach(() => {
      jest.mocked(console.error).mockRestore();
    });

    async function expectUnavailable(cause: string, errorType: unknown) {
      const error = jest.spyOn(console, 'error').mockImplementation(() => {});

      await expect(resolveProvider()).resolves.toEqual({ kind: 'custom-llm-unavailable' });

      expect(error).toHaveBeenCalledWith('Custom LLM credentials are unusable', PUBLIC_ID, {
        cause,
        errorType,
      });
    }

    it('fails closed when the custom LLM has no credentials', async () => {
      await insertCustomLlmForTest(PUBLIC_ID, definition, null);

      await expectUnavailable('missing', undefined);
    });

    it('fails closed when the credentials are not valid JSON', async () => {
      await insertCustomLlmForTest(
        PUBLIC_ID,
        definition,
        testCustomLlmCredentialsEnvelope('not json')
      );

      await expectUnavailable('unparseable', undefined);
    });

    it('fails closed when the credentials cannot be decrypted', async () => {
      const wrongDataKey = Buffer.alloc(32, 9).toString('base64');
      const credentials = JSON.stringify({ type: 'api_key', api_key: 'upstream-key' });
      await insertCustomLlmForTest(PUBLIC_ID, definition, {
        ...testCustomLlmCredentialsEnvelope({ type: 'api_key', api_key: 'upstream-key' }),
        encrypted_data: testByokEnvelope(credentials, wrongDataKey).encrypted_data,
      });

      await expectUnavailable('decrypt-failed', expect.any(String));
    });

    it('fails closed when the KMS rejects the request', async () => {
      await insertCustomLlm({ type: 'api_key', api_key: 'upstream-key' });
      fakeKms.failWith('/decrypt', 403);

      await expectUnavailable('kms-rejected', 'ByokKmsStatusError');
      expect(fakeKms.requests.filter(request => request.path === '/decrypt')).toHaveLength(1);
    });

    it('fails closed when the KMS is unavailable', async () => {
      await insertCustomLlm({ type: 'api_key', api_key: 'upstream-key' });
      fakeKms.failWith('/decrypt', 503);

      await expectUnavailable('kms-unavailable', 'ByokKmsStatusError');
    });

    it('fails closed when the Google service account cannot authenticate', async () => {
      await insertCustomLlm({
        type: 'service_account',
        project_id: 'example-project',
        private_key_id: 'key-id',
        private_key: 'not a private key',
        client_email: 'custom-llm@example-project.iam.gserviceaccount.com',
        client_id: '1234567890',
        auth_uri: 'https://accounts.google.com/o/oauth2/auth',
        token_uri: 'https://oauth2.googleapis.com/token',
        auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
        client_x509_cert_url:
          'https://www.googleapis.com/robot/v1/metadata/x509/custom-llm%40example-project.iam.gserviceaccount.com',
      });

      const error = jest.spyOn(console, 'error').mockImplementation(() => {});

      await expect(resolveProvider()).resolves.toEqual({ kind: 'custom-llm-unavailable' });

      expect(error).toHaveBeenCalledWith(
        'Custom LLM credentials are unusable',
        PUBLIC_ID,
        expect.objectContaining({ cause: 'auth-failed' })
      );
    });
  });
});
