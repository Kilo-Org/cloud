import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleLoginFixturePath } from './login-fixture';

const mocks = vi.hoisted(() => ({
  write: vi.fn(() => Promise.resolve()),
  replace: vi.fn(),
}));

vi.mock('expo-router', () => ({ router: { replace: mocks.replace } }));
vi.mock('@/lib/config', () => ({ API_BASE_URL: 'http://localhost:3000' }));
vi.mock('@/lib/auth/pending-external-auth', () => ({
  writePendingExternalAuth: mocks.write,
}));

beforeEach(() => {
  mocks.write.mockClear();
  mocks.replace.mockReset();
});

describe('handleLoginFixturePath', () => {
  it.each([
    ['pending', 'dev-seed-device-auth-pending'],
    ['denied', 'dev-seed-device-auth-denied'],
    ['expired', 'dev-seed-device-auth-missing'],
    ['error', ''],
  ])('resumes a %s sign-in, then opens the sign-in screen', async (state, deviceCode) => {
    expect(handleLoginFixturePath(`/dev/login-fixture/${state}`)).toBe(true);
    await vi.waitFor(() => {
      expect(mocks.replace).toHaveBeenCalledWith('/(auth)/login');
    });
    expect(mocks.write).toHaveBeenCalledWith({
      deviceCode,
      userCode: 'DEVS-EED1',
      verificationUrl: 'http://localhost:3000/device-auth?code=DEVS-EED1',
      startedAt: expect.any(Number),
    });
    expect(mocks.write.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.replace.mock.invocationCallOrder[0] ?? 0
    );
  });

  it('ignores other states and paths', () => {
    expect(handleLoginFixturePath('/dev/login-fixture/approved')).toBe(false);
    expect(handleLoginFixturePath('/dev/home-fixture/pending')).toBe(false);
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
