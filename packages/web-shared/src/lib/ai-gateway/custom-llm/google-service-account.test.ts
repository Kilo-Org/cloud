import { generateKeyPairSync } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type * as GoogleAuthLibrary from 'google-auth-library';
import { GoogleAuth, gaxios } from 'google-auth-library';
import {
  CustomLlmCredentialsSchema,
  CustomLlmDefinitionSchema,
  type GoogleServiceAccountKey,
} from '@kilocode/db/schema-types';
import {
  getGoogleServiceAccountAccessToken,
  MAX_CACHED_AUTH_CLIENTS,
} from './google-service-account';

jest.mock('google-auth-library', () => ({
  ...jest.requireActual<typeof GoogleAuthLibrary>('google-auth-library'),
  GoogleAuth: jest.fn(),
}));

const mockGoogleAuth = jest.mocked(GoogleAuth);

function serviceAccount(privateKey: string): GoogleServiceAccountKey {
  return {
    type: 'service_account',
    project_id: 'example-project',
    private_key_id: 'key-id',
    private_key: privateKey,
    client_email: 'custom-llm@example-project.iam.gserviceaccount.com',
    client_id: '1234567890',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url:
      'https://www.googleapis.com/robot/v1/metadata/x509/custom-llm%40example-project.iam.gserviceaccount.com',
  };
}

const baseDefinition = {
  internal_id: 'gemini-2.5-pro',
  display_name: 'Vertex Gemini',
  context_length: 1_000_000,
  max_completion_tokens: 65_536,
  base_url: 'https://us-central1-aiplatform.googleapis.com/v1',
  organization_ids: ['00000000-0000-4000-8000-000000000001'],
};

describe('CustomLlmCredentialsSchema and CustomLlmDefinitionSchema', () => {
  it('accepts API key credentials', () => {
    expect(
      CustomLlmCredentialsSchema.safeParse({ type: 'api_key', api_key: 'partner-token' }).success
    ).toBe(true);
  });

  it('accepts x-api-key credentials', () => {
    expect(
      CustomLlmCredentialsSchema.safeParse({ type: 'x-api-key', api_key: 'partner-token' }).success
    ).toBe(true);
  });

  it('accepts Google Cloud service account authentication', () => {
    expect(CustomLlmCredentialsSchema.safeParse(serviceAccount('private-key')).success).toBe(true);
  });

  it('accepts secure proxy credentials', () => {
    expect(
      CustomLlmCredentialsSchema.safeParse({
        type: 'secure_proxy',
        proxy_secret: 'proxy-secret',
        config: {
          url: 'https://llm.example.com/v1',
          extra_headers: { Authorization: 'Bearer partner-token' },
        },
      }).success
    ).toBe(true);
  });

  it('rejects secure proxy credentials with a non-HTTPS upstream', () => {
    expect(
      CustomLlmCredentialsSchema.safeParse({
        type: 'secure_proxy',
        proxy_secret: 'proxy-secret',
        config: { url: 'http://llm.example.com/v1' },
      }).success
    ).toBe(false);
  });

  it('accepts Amazon Bedrock IAM access key credentials', () => {
    expect(
      CustomLlmCredentialsSchema.safeParse({
        type: 'aws_bedrock',
        region: 'us-east-1',
        access_key_id: 'AKIDEXAMPLE',
        secret_access_key: 'secret-access-key',
      }).success
    ).toBe(true);
  });

  it('rejects Amazon Bedrock credentials without a region', () => {
    expect(
      CustomLlmCredentialsSchema.safeParse({
        type: 'aws_bedrock',
        access_key_id: 'AKIDEXAMPLE',
        secret_access_key: 'secret-access-key',
      }).success
    ).toBe(false);
  });

  it('validates custom LLM definition without credentials', () => {
    expect(CustomLlmDefinitionSchema.safeParse(baseDefinition).success).toBe(true);
  });

  it('rejects non-UUID organization IDs', () => {
    expect(
      CustomLlmDefinitionSchema.safeParse({
        ...baseDefinition,
        organization_ids: ['organization-1'],
      }).success
    ).toBe(false);
  });
});

describe('getGoogleServiceAccountAccessToken', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('requests a cloud-platform access token with the supplied credentials', async () => {
    const getAccessToken = jest.fn(async () => 'gcp-token');
    mockGoogleAuth.mockImplementation(() => ({ getAccessToken }) as unknown as GoogleAuth);
    const credentials = serviceAccount('private-key-one');

    await expect(getGoogleServiceAccountAccessToken(credentials)).resolves.toBe('gcp-token');
    expect(mockGoogleAuth).toHaveBeenCalledWith({
      credentials,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      clientOptions: { transporter: expect.any(gaxios.Gaxios) },
    });
  });

  it('accepts a key with only the fields needed to sign token requests', async () => {
    const getAccessToken = jest.fn(async () => 'gcp-token');
    mockGoogleAuth.mockImplementation(() => ({ getAccessToken }) as unknown as GoogleAuth);
    const credentials = {
      client_email: 'direct-byok@example-project.iam.gserviceaccount.com',
      private_key: 'private-key-four',
    };

    await expect(getGoogleServiceAccountAccessToken(credentials)).resolves.toBe('gcp-token');
    expect(mockGoogleAuth).toHaveBeenCalledWith({
      credentials,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      clientOptions: { transporter: expect.any(gaxios.Gaxios) },
    });
  });

  it('reuses the Google auth client so its access token cache remains effective', async () => {
    const getAccessToken = jest.fn(async () => 'cached-token');
    mockGoogleAuth.mockImplementation(() => ({ getAccessToken }) as unknown as GoogleAuth);
    const credentials = serviceAccount('private-key-two');

    await getGoogleServiceAccountAccessToken(credentials);
    await getGoogleServiceAccountAccessToken(credentials);

    expect(mockGoogleAuth).toHaveBeenCalledTimes(1);
    expect(getAccessToken).toHaveBeenCalledTimes(2);
  });

  it('keeps recent clients cached up to the configured capacity', async () => {
    const getAccessToken = jest.fn(async () => 'bounded-token');
    mockGoogleAuth.mockImplementation(() => ({ getAccessToken }) as unknown as GoogleAuth);
    const credentials = Array.from({ length: MAX_CACHED_AUTH_CLIENTS + 5 }, (_, index) =>
      serviceAccount(`capacity-key-${index}`)
    );

    for (const credential of credentials) {
      await getGoogleServiceAccountAccessToken(credential);
    }
    expect(mockGoogleAuth).toHaveBeenCalledTimes(credentials.length);

    mockGoogleAuth.mockClear();
    for (const credential of credentials.slice(-MAX_CACHED_AUTH_CLIENTS)) {
      await getGoogleServiceAccountAccessToken(credential);
    }
    expect(mockGoogleAuth).not.toHaveBeenCalled();

    await getGoogleServiceAccountAccessToken(credentials[0]);
    expect(mockGoogleAuth).toHaveBeenCalledTimes(1);
  });

  it('evicts the least recently used client rather than the oldest insertion', async () => {
    const getAccessToken = jest.fn(async () => 'lru-token');
    mockGoogleAuth.mockImplementation(() => ({ getAccessToken }) as unknown as GoogleAuth);
    const credentials = Array.from({ length: MAX_CACHED_AUTH_CLIENTS }, (_, index) =>
      serviceAccount(`lru-key-${index}`)
    );
    for (const credential of credentials) {
      await getGoogleServiceAccountAccessToken(credential);
    }

    await getGoogleServiceAccountAccessToken(credentials[0]);
    const newest = serviceAccount('lru-key-newest');
    await getGoogleServiceAccountAccessToken(newest);

    mockGoogleAuth.mockClear();
    for (const credential of [credentials[2], credentials[0], newest]) {
      await getGoogleServiceAccountAccessToken(credential);
    }
    expect(mockGoogleAuth).not.toHaveBeenCalled();

    await getGoogleServiceAccountAccessToken(credentials[1]);
    expect(mockGoogleAuth).toHaveBeenCalledTimes(1);
  });

  it('fails when Google returns no access token', async () => {
    const getAccessToken = jest.fn(async () => null);
    mockGoogleAuth.mockImplementation(() => ({ getAccessToken }) as unknown as GoogleAuth);

    await expect(
      getGoogleServiceAccountAccessToken(serviceAccount('private-key-three'))
    ).rejects.toThrow('Google service account authentication returned no access token');
  });

  it('does not expose credentials or the original error when authentication fails', async () => {
    const credentials = serviceAccount('private-key-failure');
    const getAccessToken = jest.fn(async () => {
      throw new Error(JSON.stringify(credentials));
    });
    mockGoogleAuth.mockImplementation(() => ({ getAccessToken }) as unknown as GoogleAuth);

    const result = getGoogleServiceAccountAccessToken(credentials);
    await expect(result).rejects.toThrow(new Error('Google service account authentication failed'));
    await expect(result).rejects.not.toHaveProperty('cause');
  });

  it('does not classify an unrelated AbortError as an exchange deadline', async () => {
    const getAccessToken = jest.fn(async () => {
      const error = new Error('Unrelated provider cancellation');
      error.name = 'AbortError';
      throw error;
    });
    mockGoogleAuth.mockImplementation(() => ({ getAccessToken }) as unknown as GoogleAuth);

    await expect(
      getGoogleServiceAccountAccessToken(serviceAccount('private-key-unrelated-abort'))
    ).rejects.toThrow(new Error('Google service account authentication failed'));
  });
});

describe('Google service account token exchange deadline', () => {
  const { GoogleAuth: RealGoogleAuth } =
    jest.requireActual<typeof GoogleAuthLibrary>('google-auth-library');
  const request = gaxios.Gaxios.prototype.request;
  let privateKey: string;
  let credentials: GoogleServiceAccountKey;
  let fetchToken: jest.MockedFunction<typeof fetch>;
  let exchange = 0;

  beforeAll(() => {
    privateKey = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey;
  });

  beforeEach(() => {
    credentials = {
      ...serviceAccount(privateKey),
      client_email: `deadline-${++exchange}@example-project.iam.gserviceaccount.com`,
    };
    fetchToken = jest.fn();
    jest.spyOn(gaxios.Gaxios.prototype, 'request').mockImplementation(function (
      this: gaxios.Gaxios,
      options = {}
    ) {
      return request.call(this, { ...options, fetchImplementation: fetchToken });
    });
    mockGoogleAuth.mockImplementation(options => new RealGoogleAuth(options));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function tokenResponse() {
    return Response.json({
      access_token: 'exchanged-token',
      expires_in: 3600,
      token_type: 'Bearer',
    });
  }

  function stalledTokenExchange(_url: Parameters<typeof fetch>[0], init?: RequestInit) {
    const signal = init?.signal;
    if (!signal) throw new Error('Token exchange must provide a cancellation signal');
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }

  it('exchanges a token successfully and keeps the library token cache effective', async () => {
    fetchToken.mockResolvedValueOnce(tokenResponse());

    await expect(getGoogleServiceAccountAccessToken(credentials)).resolves.toBe('exchanged-token');
    await expect(getGoogleServiceAccountAccessToken(credentials)).resolves.toBe('exchanged-token');

    expect(fetchToken).toHaveBeenCalledTimes(1);
    expect(fetchToken).toHaveBeenCalledWith(
      new URL('https://oauth2.googleapis.com/token'),
      expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) })
    );
  });

  it('retries a transient provider failure within the exchange deadline', async () => {
    fetchToken
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(tokenResponse());

    await expect(getGoogleServiceAccountAccessToken(credentials)).resolves.toBe('exchanged-token');
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });

  it('fails immediately on invalid credentials without exposing the upstream error', async () => {
    fetchToken.mockResolvedValueOnce(
      Response.json({ error: 'invalid_grant', error_description: privateKey }, { status: 401 })
    );

    const result = getGoogleServiceAccountAccessToken(credentials);
    await expect(result).rejects.toThrow(new Error('Google service account authentication failed'));
    await expect(result).rejects.not.toHaveProperty('cause');
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });

  it('cancels a stalled token exchange and can retry with the cached client', async () => {
    fetchToken.mockImplementation(stalledTokenExchange);

    await expect(getGoogleServiceAccountAccessToken(credentials)).rejects.toThrow(
      'Google service account authentication timed out after 5 seconds'
    );
    expect(fetchToken).toHaveBeenCalledTimes(1);
    expect(fetchToken.mock.calls[0][1]?.signal?.aborted).toBe(true);

    fetchToken.mockResolvedValueOnce(tokenResponse());
    await expect(getGoogleServiceAccountAccessToken(credentials)).resolves.toBe('exchanged-token');
  }, 10_000);

  it('shares the five-second deadline across retries rather than restarting it', async () => {
    fetchToken
      .mockImplementationOnce(async () => {
        await delay(3_000);
        return new Response(null, { status: 503 });
      })
      .mockImplementation(stalledTokenExchange);
    const started = performance.now();

    await expect(getGoogleServiceAccountAccessToken(credentials)).rejects.toThrow(
      'Google service account authentication timed out after 5 seconds'
    );

    expect(performance.now() - started).toBeLessThan(6_000);
    expect(fetchToken).toHaveBeenCalledTimes(2);
    const signals = fetchToken.mock.calls.map(([, init]) => init?.signal);
    expect(signals[0]).toBe(signals[1]);
    expect(signals[1]?.aborted).toBe(true);
  }, 10_000);

  it('cancels retry backoff when the exchange deadline expires', async () => {
    fetchToken
      .mockImplementationOnce(async () => {
        await delay(4_800);
        return new Response(null, { status: 503 });
      })
      .mockResolvedValue(new Response(null, { status: 503 }));
    const started = performance.now();

    const result = getGoogleServiceAccountAccessToken(credentials);
    await expect(result).rejects.toThrow(
      'Google service account authentication timed out after 5 seconds'
    );
    await expect(result).rejects.not.toHaveProperty('cause');

    expect(performance.now() - started).toBeLessThan(5_400);
    expect(fetchToken).toHaveBeenCalledTimes(2);
    expect(fetchToken.mock.calls[1][1]?.signal?.aborted).toBe(true);
  }, 10_000);
});
