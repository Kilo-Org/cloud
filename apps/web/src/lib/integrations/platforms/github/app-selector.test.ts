import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const mockListInstallationsForAuthenticatedUser = jest.fn();

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    rest: {
      apps: {
        listInstallationsForAuthenticatedUser: mockListInstallationsForAuthenticatedUser,
      },
    },
  })),
}));

let assertUserAdministersInstallation: (params: {
  accessToken: string;
  installationId: number | string;
}) => Promise<boolean>;

beforeAll(async () => {
  const mod = await import('./app-selector');
  assertUserAdministersInstallation = mod.assertUserAdministersInstallation;
});

const INSTALLATION_ID = 98765;

function mockPage(installations: Array<{ id: number }>, totalCount: number) {
  mockListInstallationsForAuthenticatedUser.mockResolvedValueOnce({
    data: {
      total_count: totalCount,
      installations,
    },
  });
}

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
    });
    expect(mockListInstallationsForAuthenticatedUser).toHaveBeenNthCalledWith(2, {
      per_page: 100,
      page: 2,
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
});
