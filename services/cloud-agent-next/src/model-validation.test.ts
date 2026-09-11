import { signModernKiloToken } from '@kilocode/worker-utils/kilo-token-policy';
import {
  verifyRuntimeProxyAttestation,
  RUNTIME_PROXY_ATTESTATION_HEADER,
} from '@kilocode/worker-utils/runtime-proxy-attestation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import type { Env } from './types.js';
import { assertKiloModelAvailable, buildKiloOverrideValidationUrl } from './model-validation.js';

vi.mock('./logger.js', () => ({
  logger: {
    withFields: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

describe('model validation', () => {
  const originalFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  const officialEnv = {
    KILOCODE_BACKEND_BASE_URL: 'https://api.kilo.test',
    KILOCODE_ORG_ID_OVERRIDE: 'override-org',
  } as unknown as Env;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
    global.fetch = originalFetch;
  });

  it('validates the dispatched model using runtime-effective organization context', async () => {
    fetchMock.mockResolvedValue(Response.json({ valid: true }));

    await assertKiloModelAvailable({
      env: officialEnv,
      submittedModel: 'kilo/anthropic/claude-sonnet',
      originalToken: 'stored-token',
      originalOrganizationId: 'stored-org',
      createdOnPlatform: 'cloud-agent-web',
      procedure: 'start',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.kilo.test/api/organizations/override-org/models/validate');
    expect(init.method).toBe('POST');
    expect(typeof init.body).toBe('string');
    if (typeof init.body !== 'string') throw new Error('Expected JSON request body');
    expect(JSON.parse(init.body)).toEqual({ modelId: 'anthropic/claude-sonnet' });
    const headers = init.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer stored-token');
    expect(headers.get('X-KiloCode-OrganizationId')).toBe('override-org');
    expect(headers.get('X-KiloCode-Feature')).toBe('cloud-agent-web');
  });

  it('rejects an unavailable selected model as a bad request', async () => {
    fetchMock.mockResolvedValue(Response.json({ valid: false, reason: 'unavailable' }));

    await expect(
      assertKiloModelAvailable({
        env: officialEnv,
        submittedModel: 'missing/model',
        originalToken: 'stored-token',
        procedure: 'send',
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Selected model is not available for this cloud agent session',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries transient validation failures twice with exponential backoff', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockRejectedValueOnce(new Error('catalog unavailable'))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ valid: true }));

    const validation = assertKiloModelAvailable({
      env: officialEnv,
      submittedModel: 'available/model',
      originalToken: 'stored-token',
      procedure: 'send',
    });

    await vi.advanceTimersByTimeAsync(99);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(validation).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('fails closed after exhausting retries for malformed validation responses', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(Response.json({ unexpected: true }));

    const errorPromise = assertKiloModelAvailable({
      env: officialEnv,
      submittedModel: 'available/model',
      originalToken: 'stored-token',
      procedure: 'send',
    }).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    const error: unknown = await errorPromise;

    expect(error).toBeInstanceOf(TRPCError);
    expect(error).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    if (error instanceof TRPCError) {
      expect(error.cause).toMatchObject({
        error: 'MODEL_VALIDATION_UNAVAILABLE',
        retryable: true,
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries a rate-limited validation response', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(Response.json({ valid: true }));

    const validation = assertKiloModelAvailable({
      env: officialEnv,
      submittedModel: 'available/model',
      procedure: 'send',
    });
    await vi.runAllTimersAsync();

    await expect(validation).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a definitive client error', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 400 }));

    await expect(
      assertKiloModelAvailable({
        env: officialEnv,
        submittedModel: 'available/model',
        procedure: 'send',
      })
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips personal official validation when the validation route is not deployed yet', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));

    await assertKiloModelAvailable({
      env: { KILOCODE_BACKEND_BASE_URL: 'https://api.kilo.test' } as Env,
      submittedModel: 'available/model',
      procedure: 'send',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.kilo.test/api/openrouter/models/validate'
    );
  });

  it('skips organization official validation when the validation route is not deployed yet', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));

    await assertKiloModelAvailable({
      env: officialEnv,
      submittedModel: 'available/model',
      procedure: 'send',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.kilo.test/api/organizations/override-org/models/validate'
    );
  });

  it('fails closed when an override endpoint returns 404', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));

    await expect(
      assertKiloModelAvailable({
        env: { KILO_OPENROUTER_BASE: 'http://localhost:8811/api' } as Env,
        submittedModel: 'available/model',
        procedure: 'send',
      })
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries an unauthorized scoped validation against the public catalog', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ valid: true }));

    await assertKiloModelAvailable({
      env: officialEnv,
      submittedModel: 'available/model',
      originalToken: 'stored-token',
      originalOrganizationId: 'stored-org',
      procedure: 'send',
    });

    const [fallbackUrl, fallbackInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(fallbackUrl).toBe('https://api.kilo.test/api/openrouter/models/validate');
    const fallbackHeaders = fallbackInit.headers as Headers;
    expect(fallbackHeaders.get('Authorization')).toBeNull();
    expect(fallbackHeaders.get('X-KiloCode-OrganizationId')).toBeNull();
  });

  it('retries an unauthorized override validation endpoint against official public validation', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ valid: true }));

    await assertKiloModelAvailable({
      env: {
        KILOCODE_BACKEND_BASE_URL: 'https://api.kilo.test',
        KILO_OPENROUTER_BASE: 'http://localhost:8811/api',
      } as Env,
      submittedModel: 'available/model',
      originalToken: 'stored-token',
      procedure: 'send',
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://localhost:8811/api/openrouter/models/validate'
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://api.kilo.test/api/openrouter/models/validate'
    );
  });

  it('uses a token-selected validation endpoint when runtime credentials encode a URL', async () => {
    const routedToken = 'http://localhost:9911/api/openrouter:routed-token';
    fetchMock.mockResolvedValue(Response.json({ valid: true }));

    await assertKiloModelAvailable({
      env: { KILOCODE_BACKEND_BASE_URL: 'https://api.kilo.test' } as Env,
      submittedModel: 'available/model',
      originalToken: routedToken,
      procedure: 'start',
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://localhost:9911/api/openrouter/models/validate'
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ modelId: 'available/model' }),
    });
  });

  it('fails closed when an override validation endpoint returns a malformed response', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(Response.json({ unexpected: true }));

    const validation = assertKiloModelAvailable({
      env: { KILO_OPENROUTER_BASE: 'http://localhost:8811/api' } as Env,
      submittedModel: 'available/model',
      procedure: 'start',
    }).catch((error: unknown) => error);
    await vi.runAllTimersAsync();

    await expect(validation).resolves.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('calls the organization-scoped override validation endpoint', async () => {
    fetchMock.mockResolvedValue(Response.json({ valid: true }));

    await assertKiloModelAvailable({
      env: { KILO_OPENROUTER_BASE: 'http://localhost:8811/api' } as Env,
      submittedModel: 'image/model',
      originalOrganizationId: 'org-1',
      procedure: 'start',
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://localhost:8811/api/organizations/org-1/models/validate'
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ modelId: 'image/model' }),
    });
  });
});

describe('buildKiloOverrideValidationUrl', () => {
  it('matches Kilo personal and organization URL normalization', () => {
    expect(buildKiloOverrideValidationUrl('http://localhost:8811/api/', undefined)).toBe(
      'http://localhost:8811/api/openrouter/models/validate'
    );
    expect(buildKiloOverrideValidationUrl('http://localhost:8811/api/openrouter', undefined)).toBe(
      'http://localhost:8811/api/openrouter/models/validate'
    );
    expect(buildKiloOverrideValidationUrl('http://localhost:8811/api', 'org-1')).toBe(
      'http://localhost:8811/api/organizations/org-1/models/validate'
    );
    expect(buildKiloOverrideValidationUrl('http://localhost:8811/api', 'org/a?b=c')).toBe(
      'http://localhost:8811/api/organizations/org%2Fa%3Fb%3Dc/models/validate'
    );
    expect(buildKiloOverrideValidationUrl('http://localhost:8811', 'org/a?b=c')).toBe(
      'http://localhost:8811/api/organizations/org%2Fa%3Fb%3Dc/models/validate'
    );
    expect(
      buildKiloOverrideValidationUrl('http://localhost:8811/api/organizations/org-1', 'org-1')
    ).toBe('http://localhost:8811/api/organizations/org-1/models/validate');
  });
});

describe('modern model validation trust boundary', () => {
  const secret = 'model-validation-test-secret';
  const env = { KILOCODE_BACKEND_BASE_URL: 'https://backend.test', NEXTAUTH_SECRET: secret };
  const authorizationId = '11111111-1111-4111-8111-111111111111';
  async function token(
    options: { secret?: string; audience?: string; organizationId?: string } = {}
  ) {
    return (
      await signModernKiloToken({
        userId: 'oauth/test',
        secret: options.secret ?? secret,
        expiresInSeconds: 3600,
        audience: options.audience ?? ['kilo-api', 'kilo-gateway'],
        tokenPurpose: 'delegated-workload',
        credentialExchange: false,
        extra: {
          organizationId: options.organizationId,
          runtimeAuthorization: {
            id: authorizationId,
            resourceKind: 'cloud-agent-next',
            resourceId: 'session-1',
          },
        },
      })
    ).token;
  }
  afterEach(() => vi.restoreAllMocks());

  it.each([undefined, 'org-1'])(
    'issues a bearer-bound proof for the intended audience (%s)',
    async organizationId => {
      const bearer = await token({ organizationId });
      const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(Response.json({ valid: true }));
      await assertKiloModelAvailable({
        env,
        submittedModel: 'private/model',
        originalToken: bearer,
        originalOrganizationId: organizationId,
        procedure: 'send',
      });
      const init = fetchMock.mock.calls[0][1];
      const headers = new Headers(init?.headers);
      expect(init?.redirect).toBe('manual');
      expect(
        await verifyRuntimeProxyAttestation({
          secret,
          audience: organizationId ? 'kilo-api' : 'kilo-gateway',
          userId: 'oauth/test',
          authorizationId,
          resourceId: 'session-1',
          bearer,
          value: headers.get(RUNTIME_PROXY_ATTESTATION_HEADER),
        })
      ).toBe(true);
    }
  );

  it.each([
    'missing-secret',
    'bad-signature',
    'wrong-audience',
    'foreign-organization',
    'override',
    'encoded-url',
  ])('rejects %s before sending credentials', async scenario => {
    let bearer = await token({
      secret: scenario === 'bad-signature' ? 'foreign-secret' : undefined,
      audience: scenario === 'wrong-audience' ? 'session-ingest' : undefined,
    });
    if (scenario === 'encoded-url') bearer = `https://evil.test/api/openrouter:${bearer}`;
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(Response.json({ valid: true }));
    await expect(
      assertKiloModelAvailable({
        env: {
          ...env,
          ...(scenario === 'missing-secret' ? { NEXTAUTH_SECRET: undefined } : {}),
          ...(scenario === 'override' ? { KILO_OPENROUTER_BASE: 'https://evil.test/api' } : {}),
        },
        submittedModel: 'public/model',
        originalToken: bearer,
        originalOrganizationId: scenario === 'foreign-organization' ? 'other-org' : undefined,
        procedure: 'start',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 404, 302])('does not anonymously retry or skip modern HTTP %s', async status => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status }));
    await expect(
      assertKiloModelAvailable({
        env,
        submittedModel: 'public/model',
        originalToken: await token(),
        procedure: 'send',
      })
    ).rejects.toMatchObject({ code: status === 401 ? 'FORBIDDEN' : 'SERVICE_UNAVAILABLE' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves non-runtime typed credential fallback without issuing proof', async () => {
    const bearer = (
      await signModernKiloToken({
        userId: 'oauth/test',
        secret,
        expiresInSeconds: 3600,
        audience: 'cloud-agent-next',
        tokenPurpose: 'human-api',
        credentialExchange: false,
      })
    ).token;
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ valid: true }));
    await assertKiloModelAvailable({
      env,
      submittedModel: 'public/model',
      originalToken: bearer,
      procedure: 'start',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      new Headers(fetchMock.mock.calls[0][1]?.headers).has(RUNTIME_PROXY_ATTESTATION_HEADER)
    ).toBe(false);
  });

  it('allows an override that resolves to the exact trusted backend route', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(Response.json({ valid: true }));
    await assertKiloModelAvailable({
      env: { ...env, KILO_OPENROUTER_BASE: 'https://backend.test/api' },
      submittedModel: 'private/model',
      originalToken: await token(),
      procedure: 'start',
    });
    expect(
      new Headers(fetchMock.mock.calls[0][1]?.headers).has(RUNTIME_PROXY_ATTESTATION_HEADER)
    ).toBe(true);
  });
});
