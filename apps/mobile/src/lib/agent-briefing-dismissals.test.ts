import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIEFING_DISMISSALS_KEY, readBriefingDismissals } from './agent-briefing-dismissals';

const auth = vi.hoisted(() => ({ epoch: 1, signingOut: false }));
const storage = vi.hoisted(() => ({
  getItem: vi.fn<(scope: string, key: string) => Promise<string | null>>(),
  removeItem: vi.fn<(scope: string, key: string) => Promise<void>>(),
}));
vi.mock('@/lib/auth/auth-epoch', () => ({
  isCurrentAuthEpoch: (epoch: number) => epoch === auth.epoch,
}));
vi.mock('@/lib/auth/sign-out-state', () => ({ isSignOutActive: () => auth.signingOut }));
vi.mock('@/lib/persist/encrypted-kv', () => storage);
vi.mock('@/lib/persist/read-cache', () => ({
  readCacheScope: (userId: string) => `cache:${userId}:1`,
}));

const dismissal = {
  reportId: 'report-1',
  organizationId: 'org-1',
  expiresAt: '2099-10-15T12:00:00.000Z',
  synced: false,
};

describe('briefing dismissal read boundary', () => {
  beforeEach(() => {
    auth.epoch = 1;
    auth.signingOut = false;
    storage.getItem.mockReset();
    storage.removeItem.mockReset();
    storage.getItem.mockResolvedValue(JSON.stringify([dismissal]));
    storage.removeItem.mockResolvedValue(undefined);
  });

  it('reads validated dismissals from the current account encrypted scope', async () => {
    await expect(readBriefingDismissals('user-1', 1)).resolves.toEqual([dismissal]);
    expect(storage.getItem).toHaveBeenCalledWith('cache:user-1:1', BRIEFING_DISMISSALS_KEY);
  });

  it('refuses disk reads after sign-out starts or an account epoch changes', async () => {
    auth.signingOut = true;
    await expect(readBriefingDismissals('user-1', 1)).resolves.toEqual([]);
    auth.signingOut = false;
    auth.epoch = 2;
    await expect(readBriefingDismissals('user-1', 1)).resolves.toEqual([]);
    expect(storage.getItem).not.toHaveBeenCalled();
  });

  it('does not hydrate a private response that arrives after sign-out starts', async () => {
    storage.getItem.mockImplementation(async () => {
      auth.signingOut = true;
      await Promise.resolve();
      return JSON.stringify([dismissal]);
    });
    await expect(readBriefingDismissals('user-1', 1)).resolves.toEqual([]);
  });

  it('does not hydrate a previous account response after the auth epoch changes', async () => {
    storage.getItem.mockImplementation(async () => {
      auth.epoch = 2;
      await Promise.resolve();
      return JSON.stringify([dismissal]);
    });
    await expect(readBriefingDismissals('user-1', 1)).resolves.toEqual([]);
  });

  it('drops malformed or expired persisted records', async () => {
    storage.getItem.mockResolvedValueOnce('{');
    await expect(readBriefingDismissals('user-1', 1)).resolves.toEqual([]);
    expect(storage.removeItem).toHaveBeenCalledWith('cache:user-1:1', BRIEFING_DISMISSALS_KEY);
    storage.getItem.mockResolvedValueOnce(
      JSON.stringify([{ ...dismissal, expiresAt: '2000-01-01T00:00:00.000Z' }])
    );
    await expect(readBriefingDismissals('user-1', 1)).resolves.toEqual([]);
    storage.getItem.mockResolvedValueOnce(
      JSON.stringify([{ ...dismissal, expiresAt: 'not-a-date' }])
    );
    await expect(readBriefingDismissals('user-1', 1)).resolves.toEqual([]);
  });
});
