import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import {
  GITHUB_LISTING_TIMEOUT_MS,
  GitHubListingBudgetExceededError,
  MAX_GITHUB_LISTING_BYTES,
} from './listing-budget';

const mockListInstallationsForAuthenticatedUser = jest.fn<
  (_params: { per_page: number; page: number; request: { signal: AbortSignal } }) => Promise<{
    data: { total_count: number; installations: Array<{ id: number; padding?: string }> };
  }>
>();

jest.mock(
  '@octokit/rest',
  () =>
    ({
      Octokit: jest.fn().mockImplementation(() => ({
        rest: {
          apps: {
            listInstallationsForAuthenticatedUser: mockListInstallationsForAuthenticatedUser,
          },
        },
      })),
    }) as never
);

let assertUserAdministersInstallation: (params: {
  accessToken: string;
  installationId: number | string;
}) => Promise<boolean>;

beforeAll(async () => {
  const mod = await import('./app-selector');
  assertUserAdministersInstallation = mod.assertUserAdministersInstallation;
});

const INSTALLATION_ID = 98765;

function mockPage(installations: Array<{ id: number; padding?: string }>, totalCount: number) {
  mockListInstallationsForAuthenticatedUser.mockResolvedValueOnce({
    data: {
      total_count: totalCount,
      installations,
    },
  });
}

const SIGNAL = { signal: expect.any(AbortSignal) };

describe('assertUserAdministersInstallation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns true when the installation is on the first page', async () => {
    mockPage([{ id: INSTALLATION_ID }, { id: 11111 }], 2);

    const result = await assertUserAdministersInstallation({
      accessToken: 'test-token',
      installationId: INSTALLATION_ID,
    });

    expect(result).toBe(true);
    expect(mockListInstallationsForAuthenticatedUser).toHaveBeenCalledTimes(1);
    expect(mockListInstallationsForAuthenticatedUser).toHaveBeenCalledWith({
      per_page: 100,
      page: 1,
      request: SIGNAL,
    });
  });

  test('returns true when the installation is on page two of a paginated result', async () => {
    // Page 1: 100 installations, none matching.
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: 10000 + i }));
    mockPage(page1, 101);

    // Page 2: 1 installation, matching.
    mockPage([{ id: INSTALLATION_ID }], 101);

    const result = await assertUserAdministersInstallation({
      accessToken: 'test-token',
      installationId: INSTALLATION_ID,
    });

    expect(result).toBe(true);
    expect(mockListInstallationsForAuthenticatedUser).toHaveBeenCalledTimes(2);
    expect(mockListInstallationsForAuthenticatedUser).toHaveBeenNthCalledWith(1, {
      per_page: 100,
      page: 1,
      request: SIGNAL,
    });
    expect(mockListInstallationsForAuthenticatedUser).toHaveBeenNthCalledWith(2, {
      per_page: 100,
      page: 2,
      request: SIGNAL,
    });
  });

  test('returns false when the installation is absent from all pages', async () => {
    mockPage([{ id: 11111 }, { id: 22222 }], 2);

    const result = await assertUserAdministersInstallation({
      accessToken: 'test-token',
      installationId: INSTALLATION_ID,
    });

    expect(result).toBe(false);
    expect(mockListInstallationsForAuthenticatedUser).toHaveBeenCalledTimes(1);
  });

  test('accepts installationId as a string', async () => {
    mockPage([{ id: INSTALLATION_ID }], 1);

    const result = await assertUserAdministersInstallation({
      accessToken: 'test-token',
      installationId: '98765',
    });

    expect(result).toBe(true);
  });

  test('throws on API error rather than returning false', async () => {
    mockListInstallationsForAuthenticatedUser.mockRejectedValueOnce(new Error('Bad credentials'));

    await expect(
      assertUserAdministersInstallation({
        accessToken: 'test-token',
        installationId: INSTALLATION_ID,
      })
    ).rejects.toThrow('Bad credentials');
  });

  test('enforces MAX_GITHUB_PAGINATION_PAGES', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: 10000 + i }));
    mockListInstallationsForAuthenticatedUser.mockResolvedValue({
      data: { total_count: 1_000_000, installations: fullPage },
    });

    const thrown: unknown = await assertUserAdministersInstallation({
      accessToken: 'test-token',
      installationId: INSTALLATION_ID,
    }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(GitHubListingBudgetExceededError);
    expect((thrown as Error).message).toBe(
      'GitHub pagination limit exceeded: installation administration listing returned more than 100 pages'
    );
    expect(mockListInstallationsForAuthenticatedUser).toHaveBeenCalledTimes(100);
  });

  test('enforces MAX_GITHUB_LISTING_BYTES', async () => {
    const padding = 'x'.repeat(MAX_GITHUB_LISTING_BYTES);
    mockPage([{ id: INSTALLATION_ID, padding }], 1);

    const thrown: unknown = await assertUserAdministersInstallation({
      accessToken: 'test-token',
      installationId: INSTALLATION_ID,
    }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(GitHubListingBudgetExceededError);
    expect((thrown as Error).message).toBe(
      `GitHub pagination limit exceeded: installation administration listing returned more than ${MAX_GITHUB_LISTING_BYTES / (1024 * 1024)} MiB`
    );
    expect(mockListInstallationsForAuthenticatedUser).toHaveBeenCalledTimes(1);
  });

  test('enforces GITHUB_LISTING_TIMEOUT_MS', async () => {
    jest.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      mockListInstallationsForAuthenticatedUser.mockImplementation(
        (params: { request: { signal: AbortSignal } }) => {
          const { signal } = params.request;
          signals.push(signal);
          const { promise, reject } = Promise.withResolvers<never>();
          const abort = () => reject(signal.reason);
          if (signal.aborted) {
            abort();
            return promise;
          }
          signal.addEventListener('abort', abort, { once: true });
          return promise;
        }
      );

      const walk = assertUserAdministersInstallation({
        accessToken: 'test-token',
        installationId: INSTALLATION_ID,
      });
      const settled = walk.catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(GITHUB_LISTING_TIMEOUT_MS);
      const thrown: unknown = await settled;

      expect(thrown).toBeInstanceOf(GitHubListingBudgetExceededError);
      expect((thrown as Error).message).toBe(
        `GitHub pagination limit exceeded: installation administration listing did not finish within ${GITHUB_LISTING_TIMEOUT_MS / 1000} s`
      );
      expect(signals).toHaveLength(1);
      expect(signals[0].aborted).toBe(true);
      expect(signals[0].reason.name).toBe('AbortError');
      expect(signals[0].reason.cause).toBeInstanceOf(GitHubListingBudgetExceededError);
    } finally {
      jest.useRealTimers();
    }
  });
});
