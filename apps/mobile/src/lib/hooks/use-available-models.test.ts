import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TELEMETRY_DESCRIPTION_KEY } from '@/lib/telemetry/error-sink';

import {
  fetchModels,
  fetchOrgDefaults,
  OpenRouterModelsResponseSchema,
  OrganizationDefaultsResponseSchema,
  toModelOptions,
} from './use-available-models';

// Stub native/expo modules so pure-node Vitest can resolve the
// module graph when importing from use-available-models.ts.
vi.mock('expo-secure-store', () => ({}));
vi.mock('@tanstack/react-query', () => ({}));
vi.mock('@/lib/config', () => ({ API_BASE_URL: 'https://api.example.com' }));
vi.mock('@/lib/storage-keys', () => ({
  ACTIVE_USER_ID_KEY: 'active-user-id',
  AUTH_TOKEN_KEY: 'mock-token',
  ORGANIZATION_STORAGE_KEY: 'organization',
}));
vi.mock('@/lib/auth/token-owner', () => ({
  getAuthTokenForRequest: () => Promise.resolve(null),
}));

describe('toModelOptions', () => {
  it('passes pricing through to the ModelOption', () => {
    const pricing = { prompt: '0.00000175', completion: '0.000014' };
    const result = toModelOptions({
      data: [
        {
          id: 'priced/model',
          name: 'Display: Priced Model',
          pricing,
          preferredIndex: 0,
          opencode: { variants: { high: {} } },
        },
      ],
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.pricing).toEqual(pricing);
    expect(result[0]?.id).toBe('priced/model');
    expect(result[0]?.name).toBe('Priced Model');
  });

  it('returns empty array for undefined data', () => {
    expect(toModelOptions(undefined)).toEqual([]);
  });
});

describe('OpenRouterModelsResponseSchema', () => {
  it('parses a valid body with a data array', () => {
    const body = {
      data: [
        {
          id: 'priced/model',
          name: 'Display: Priced Model',
          pricing: { prompt: '0.00000175', completion: '0.000014' },
          preferredIndex: 0,
          opencode: { variants: { high: {} } },
        },
      ],
    };
    expect(OpenRouterModelsResponseSchema.parse(body)).toEqual(body);
  });

  it('rejects a body missing the data field', () => {
    expect(() => OpenRouterModelsResponseSchema.parse({})).toThrow();
  });

  it('rejects a data array entry missing the id field', () => {
    expect(() => OpenRouterModelsResponseSchema.parse({ data: [{ name: 'Noid' }] })).toThrow();
  });

  it('ignores extra fields on a data entry', () => {
    const parsed = OpenRouterModelsResponseSchema.parse({
      data: [{ id: 'a', name: 'A', someUnknown: true }],
    });
    expect(parsed.data[0]).toEqual({ id: 'a', name: 'A' });
  });
});

describe('OrganizationDefaultsResponseSchema', () => {
  it('parses a valid defaultModel body', () => {
    expect(OrganizationDefaultsResponseSchema.parse({ defaultModel: 'priced/model' })).toEqual({
      defaultModel: 'priced/model',
    });
  });

  it('rejects a body missing defaultModel', () => {
    expect(() => OrganizationDefaultsResponseSchema.parse({})).toThrow();
  });

  it('ignores extra fields', () => {
    expect(OrganizationDefaultsResponseSchema.parse({ defaultModel: 'm', extra: true })).toEqual({
      defaultModel: 'm',
    });
  });
});

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function refusal(status: number, statusText: string): Response {
  return new Response(null, { status, statusText });
}

function declaredTelemetry(error: Error): unknown {
  return Reflect.get(error, TELEMETRY_DESCRIPTION_KEY);
}

async function rejectionOf(read: () => Promise<unknown>): Promise<Error> {
  try {
    await read();
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected the read to reject');
}

describe('model-catalog read failures', () => {
  it('keeps a successful models read unchanged', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ data: [{ id: 'a', name: 'A' }] }));

    await expect(fetchModels('org_1', 'member')).resolves.toEqual({
      data: [{ id: 'a', name: 'A' }],
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.example.com/api/organizations/org_1/models'
    );
  });

  // A 401 is the answer a locked keychain or a sign-out teardown produces, so
  // the shared network policy treats it as an expected answer: warning level,
  // and `report: 'none'` because the global fetch wrapper already records it.
  it('files an expected 401 models answer as a warning, not an app error', async () => {
    fetchMock.mockResolvedValueOnce(refusal(401, 'Unauthorized'));

    const error = await rejectionOf(() => fetchModels(undefined, 'member'));

    expect(error.name).toBe('ModelCatalogFetchError');
    expect(error.message).toBe('Failed to fetch models: 401 Unauthorized');
    expect(declaredTelemetry(error)).toEqual({
      level: 'warning',
      report: 'none',
      fingerprint: ['models-fetch', 'models', 'http.401', 'member'],
      tags: {
        'error.subsystem': 'model-catalog',
        'error.operation': 'models',
        'http.status': 401,
      },
    });
  });

  it('files a 500 models answer as an error under the same stable fingerprint', async () => {
    fetchMock.mockResolvedValueOnce(refusal(500, 'Internal Server Error'));

    const error = await rejectionOf(() => fetchModels(undefined, 'member'));

    expect(error.message).toBe('Failed to fetch models: 500 Internal Server Error');
    expect(declaredTelemetry(error)).toEqual({
      level: 'error',
      report: 'none',
      fingerprint: ['models-fetch', 'models', 'http.500', 'member'],
      tags: {
        'error.subsystem': 'model-catalog',
        'error.operation': 'models',
        'http.status': 500,
      },
    });
  });

  it('keeps the audience in the models fingerprint', async () => {
    fetchMock.mockResolvedValueOnce(refusal(500, 'Internal Server Error'));

    const error = await rejectionOf(() => fetchModels('org_1', 'shared_services'));

    expect(declaredTelemetry(error)).toMatchObject({
      fingerprint: ['models-fetch', 'models', 'http.500', 'shared_services'],
    });
  });

  it('treats an edge-refusal 403 on the org defaults as expected and a 503 as a defect', async () => {
    fetchMock.mockResolvedValueOnce(refusal(403, 'Forbidden'));
    const expected = await rejectionOf(() => fetchOrgDefaults('org_1'));

    expect(expected.message).toBe('Failed to fetch org defaults: 403 Forbidden');
    expect(declaredTelemetry(expected)).toEqual({
      level: 'warning',
      report: 'none',
      fingerprint: ['models-fetch', 'org-defaults', 'http.403'],
      tags: {
        'error.subsystem': 'model-catalog',
        'error.operation': 'org-defaults',
        'http.status': 403,
      },
    });

    fetchMock.mockResolvedValueOnce(refusal(503, 'Service Unavailable'));
    const defect = await rejectionOf(() => fetchOrgDefaults('org_1'));

    expect(declaredTelemetry(defect)).toMatchObject({
      level: 'error',
      fingerprint: ['models-fetch', 'org-defaults', 'http.503'],
    });
  });
});
