const mockFetch = jest.fn();
global.fetch = mockFetch;

async function loadInvalidateUserAuthCache(config: {
  SESSION_INGEST_WORKER_URL: string;
  INTERNAL_API_SECRET: string;
}) {
  jest.resetModules();
  jest.doMock('@sentry/nextjs', () => ({
    captureException: jest.fn(),
  }));
  jest.doMock('@/lib/tokens', () => ({
    generateInternalServiceToken: jest.fn(),
  }));
  jest.doMock('@/lib/config.server', () => config);
  const mod = await import('./session-ingest-client');
  return mod.invalidateUserAuthCache;
}

describe('invalidateUserAuthCache skip-when-unset', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('skips when SESSION_INGEST_WORKER_URL is unset', async () => {
    const invalidateUserAuthCache = await loadInvalidateUserAuthCache({
      SESSION_INGEST_WORKER_URL: '',
      INTERNAL_API_SECRET: 'internal-secret',
    });

    await expect(invalidateUserAuthCache('usr_blocked')).resolves.toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips when INTERNAL_API_SECRET is unset', async () => {
    const invalidateUserAuthCache = await loadInvalidateUserAuthCache({
      SESSION_INGEST_WORKER_URL: 'https://ingest.test.example.com',
      INTERNAL_API_SECRET: '',
    });

    await expect(invalidateUserAuthCache('usr_blocked')).resolves.toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
