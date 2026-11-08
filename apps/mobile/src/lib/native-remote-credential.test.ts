import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nativeRemoteCredential } from './native-remote-credential';

const mocks = vi.hoisted(() => ({
  epoch: 1,
  tearingDown: false,
  expiresAtMs: null as number | null,
  token: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('@/lib/auth/auth-epoch', () => ({
  isCurrentAuthEpoch: (epoch: number) => epoch === mocks.epoch,
}));
vi.mock('@/lib/auth/credentials', () => ({
  performRefresh: mocks.refresh,
  REFRESH_MARGIN_MS: 30_000,
}));
vi.mock('@/lib/auth/token-owner', () => ({
  getAuthTokenForRequest: mocks.token,
  getActiveTokenSnapshot: () => ({ expiresAtMs: mocks.expiresAtMs }),
  isSignOutTeardownActive: () => mocks.tearingDown,
}));

beforeEach(() => {
  mocks.epoch = 1;
  mocks.tearingDown = false;
  mocks.expiresAtMs = null;
  mocks.token.mockReset().mockResolvedValue('native-device-token');
  mocks.refresh.mockReset().mockResolvedValue({ ok: true });
});

describe('native remote credential', () => {
  it('uses the signed-in device credential without minting a second API token', async () => {
    await expect(nativeRemoteCredential(1)).resolves.toBe('native-device-token');
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('refreshes an expiring access credential before grant exchange', async () => {
    mocks.expiresAtMs = Date.now() + 1000;
    mocks.token.mockResolvedValueOnce('old').mockResolvedValueOnce('new');
    await expect(nativeRemoteCredential(1)).resolves.toBe('new');
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it('leaves a sufficiently fresh credential alone', async () => {
    mocks.expiresAtMs = Date.now() + 300_000;
    await expect(nativeRemoteCredential(1)).resolves.toBe('native-device-token');
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('refuses sign-out before accessing credential storage', async () => {
    mocks.tearingDown = true;
    await expect(nativeRemoteCredential(1)).rejects.toThrow('account changed');
    expect(mocks.token).not.toHaveBeenCalled();
  });

  it('refuses a credential read that finishes for another account', async () => {
    const pending = Promise.withResolvers<string>();
    mocks.token.mockReturnValueOnce(pending.promise);
    const request = nativeRemoteCredential(1);
    mocks.epoch = 2;
    pending.resolve('new-account-token');
    await expect(request).rejects.toThrow('account changed');
  });

  it('fences an account change during refresh', async () => {
    const pending = Promise.withResolvers<{ ok: boolean }>();
    mocks.expiresAtMs = Date.now();
    mocks.refresh.mockReturnValueOnce(pending.promise);
    const request = nativeRemoteCredential(1);
    await vi.waitFor(() => {
      expect(mocks.refresh).toHaveBeenCalledTimes(1);
    });
    mocks.epoch = 2;
    pending.resolve({ ok: true });
    await expect(request).rejects.toThrow('account changed');
    expect(mocks.token).toHaveBeenCalledTimes(1);
  });

  it('refuses an absent credential', async () => {
    mocks.token.mockResolvedValueOnce(null);
    await expect(nativeRemoteCredential(1)).rejects.toThrow('requires sign-in');
  });
});
