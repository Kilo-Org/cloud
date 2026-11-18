jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn(),
}));
jest.mock('./app-selector', () => ({ getGitHubAppCredentials: jest.fn() }));

import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { getGitHubAppCredentials } from './app-selector';
import { verifyAndDeleteGitHubOrganizationInstallation } from './adapter';

const mockGetInstallation = jest.fn();
const mockDeleteInstallation = jest.fn();
const mockAuth = jest.fn();

describe('verifyAndDeleteGitHubOrganizationInstallation', () => {
  beforeEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
    jest.mocked(createAppAuth).mockReturnValue(mockAuth as never);
    jest.mocked(Octokit).mockImplementation(
      () =>
        ({
          apps: {
            getInstallation: mockGetInstallation,
            deleteInstallation: mockDeleteInstallation,
          },
        }) as never
    );
    jest.mocked(getGitHubAppCredentials).mockReturnValue({
      appId: '42',
      privateKey: 'private-key',
    } as never);
    mockAuth.mockResolvedValue({ token: 'app-token' });
    mockGetInstallation.mockResolvedValue({
      data: { id: 123, app_id: 42, account: { id: 456, type: 'Organization' } },
    });
    mockDeleteInstallation.mockResolvedValue({ status: 204 });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('gets the exact app installation before deleting it with silent logging', async () => {
    await verifyAndDeleteGitHubOrganizationInstallation({
      installationId: '123',
      accountId: '456',
      appType: 'standard',
    });
    expect(mockGetInstallation).toHaveBeenCalledWith(
      expect.objectContaining({ installation_id: 123 })
    );
    expect(mockDeleteInstallation).toHaveBeenCalledWith(
      expect.objectContaining({ installation_id: 123 })
    );
    expect(Octokit).toHaveBeenCalledWith(
      expect.objectContaining({ log: expect.objectContaining({ debug: expect.any(Function) }) })
    );
    const options = jest.mocked(Octokit).mock.calls[0]?.[0] as {
      log: { error: (message: string) => void };
    };
    expect(() => options.log.error('private-key app-token')).not.toThrow();
  });

  test.each([
    { id: 999, app_id: 42, account: { id: 456, type: 'Organization' } },
    { id: 123, app_id: 42, account: { id: 999, type: 'Organization' } },
    { id: 123, app_id: 42, account: { id: 456, type: 'User' } },
    { id: 123, app_id: 999, account: { id: 456, type: 'Organization' } },
  ])('refuses mismatched upstream identity', async data => {
    mockGetInstallation.mockResolvedValue({ data });
    await expect(
      verifyAndDeleteGitHubOrganizationInstallation({
        installationId: '123',
        accountId: '456',
        appType: 'standard',
      })
    ).rejects.toThrow('identity mismatch');
    expect(mockDeleteInstallation).not.toHaveBeenCalled();
  });

  test('rejects unavailable credentials and non-204 delete responses', async () => {
    jest.mocked(getGitHubAppCredentials).mockReturnValue({ appId: '', privateKey: '' } as never);
    await expect(
      verifyAndDeleteGitHubOrganizationInstallation({
        installationId: '123',
        accountId: '456',
        appType: 'lite',
      })
    ).rejects.toThrow('credentials unavailable');
    mockDeleteInstallation.mockResolvedValue({ status: 202 });
    jest.mocked(getGitHubAppCredentials).mockReturnValue({
      appId: '42',
      privateKey: 'private-key',
    } as never);
    await expect(
      verifyAndDeleteGitHubOrganizationInstallation({
        installationId: '123',
        accountId: '456',
        appType: 'lite',
      })
    ).rejects.toThrow('deletion not confirmed');
  });

  test('aborts both upstream calls at the bounded deadline', async () => {
    jest.useFakeTimers();
    let signal: AbortSignal | undefined;
    mockGetInstallation.mockImplementation(({ request }) => {
      signal = request.signal;
      return new Promise((_, reject) => {
        request.signal.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError'))
        );
      });
    });
    const result = verifyAndDeleteGitHubOrganizationInstallation({
      installationId: '123',
      accountId: '456',
      appType: 'standard',
    });
    void result.catch(() => {});
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(8_000);
    expect(signal?.aborted).toBe(true);
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  });
});
