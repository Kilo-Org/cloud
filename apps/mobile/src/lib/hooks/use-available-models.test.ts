import { beforeEach, describe, expect, it, vi } from 'vitest';

import { toModelOptions, useOrgDefaultModel } from './use-available-models';

const { getItemAsync } = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
}));

const { useQueryMock } = vi.hoisted(() => ({
  useQueryMock: vi.fn(),
}));

// Stub native/expo modules so pure-node Vitest can resolve the
// module graph when importing from use-available-models.ts.
vi.mock('expo-secure-store', () => ({ getItemAsync }));
vi.mock('@tanstack/react-query', () => ({ useQuery: useQueryMock }));
vi.mock('@/lib/config', () => ({ API_BASE_URL: 'https://api.example.com' }));
vi.mock('@/lib/storage-keys', () => ({ AUTH_TOKEN_KEY: 'auth-token-key' }));

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

describe('useOrgDefaultModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not specify Authorization header when organization id is not present', async () => {
    getItemAsync.mockResolvedValue('test-jwt-token');
    const captured = { queryFn: vi.fn() };
    useQueryMock.mockImplementation((options: { queryFn: () => Promise<unknown> }) => {
      captured.queryFn = vi.fn(options.queryFn);
      return { data: { defaultModel: 'kilo-auto/balanced' }, isLoading: false };
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ defaultModel: 'kilo-auto/balanced' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const hookResult = useOrgDefaultModel(undefined);
    expect(hookResult.defaultModel).toBe('kilo-auto/balanced');
    expect(useQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ['org-default-model', undefined],
        enabled: true,
      })
    );

    const result = await captured.queryFn();
    expect(result).toEqual({ defaultModel: 'kilo-auto/balanced' });
    expect(mockFetch).toHaveBeenCalledWith('https://api.example.com/api/defaults', {
      headers: {
        Accept: 'application/json',
      },
    });

    vi.unstubAllGlobals();
  });

  it('specifies Authorization header when organization id is present', async () => {
    getItemAsync.mockResolvedValue('test-jwt-token');
    const captured = { queryFn: vi.fn() };
    useQueryMock.mockImplementation((options: { queryFn: () => Promise<unknown> }) => {
      captured.queryFn = vi.fn(options.queryFn);
      return { data: { defaultModel: 'org-default-model' }, isLoading: false };
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ defaultModel: 'org-default-model' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const hookResult = useOrgDefaultModel('org-123');
    expect(hookResult.defaultModel).toBe('org-default-model');
    expect(useQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ['org-default-model', 'org-123'],
        enabled: true,
      })
    );

    const result = await captured.queryFn();
    expect(result).toEqual({ defaultModel: 'org-default-model' });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/api/organizations/org-123/defaults',
      {
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer test-jwt-token',
        },
      }
    );

    vi.unstubAllGlobals();
  });
});
