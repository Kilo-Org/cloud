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
    KILOCODE_TOKEN_OVERRIDE: 'override-token',
    KILOCODE_ORG_ID_OVERRIDE: 'override-org',
  } as unknown as Env;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
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
    expect(headers.get('Authorization')).toBe('Bearer override-token');
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
  });

  it('fails closed with a retryable service error for malformed validation responses', async () => {
    fetchMock.mockResolvedValue(Response.json({ unexpected: true }));

    try {
      await assertKiloModelAvailable({
        env: officialEnv,
        submittedModel: 'available/model',
        originalToken: 'stored-token',
        procedure: 'send',
      });
      throw new Error('Expected validation failure');
    } catch (error) {
      expect(error).toBeInstanceOf(TRPCError);
      expect(error).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
      if (error instanceof TRPCError) {
        expect(error.cause).toMatchObject({
          error: 'MODEL_VALIDATION_UNAVAILABLE',
          retryable: true,
        });
      }
    }
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
    fetchMock.mockResolvedValue(Response.json({ unexpected: true }));

    await expect(
      assertKiloModelAvailable({
        env: { KILO_OPENROUTER_BASE: 'http://localhost:8811/api' } as Env,
        submittedModel: 'available/model',
        procedure: 'start',
      })
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
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
