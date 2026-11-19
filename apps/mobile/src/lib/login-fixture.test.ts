import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loginFixtureRoute, writeLoginFixture } from './login-fixture';

const mocks = vi.hoisted(() => ({ write: vi.fn(() => Promise.resolve()) }));

vi.mock('@/lib/config', () => ({ API_BASE_URL: 'http://localhost:3000' }));
vi.mock('@/lib/auth/pending-external-auth', () => ({
  writePendingExternalAuth: mocks.write,
}));

beforeEach(() => {
  mocks.write.mockClear();
});

describe('loginFixtureRoute', () => {
  it('opens the fixture screen for each state', () => {
    expect(loginFixtureRoute('/dev/login-fixture/denied')).toBe(
      '/(auth)/login-fixture?state=denied'
    );
  });

  it('ignores other states and paths', () => {
    expect(loginFixtureRoute('/dev/login-fixture/approved')).toBeNull();
    expect(loginFixtureRoute('/dev/home-fixture/pending')).toBeNull();
  });
});

describe('writeLoginFixture', () => {
  it.each([
    ['pending', 'dev-seed-device-auth-pending', 'DEVP-ENDG'],
    ['denied', 'dev-seed-device-auth-denied', 'DEVD-ENYD'],
    ['expired', 'dev-seed-device-auth-missing', 'DEVX-PRDZ'],
    ['error', '', 'DEVE-RRRR'],
  ] as const)('resumes the %s sign-in with its own codes', async (state, deviceCode, userCode) => {
    await writeLoginFixture(state);
    expect(mocks.write).toHaveBeenCalledWith({
      deviceCode,
      userCode,
      verificationUrl: `http://localhost:3000/device-auth?code=${userCode}`,
      startedAt: expect.any(Number),
    });
  });
});
