jest.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/admin/step-up-store', () => ({
  evaluateStepUp: jest.fn(),
}));

import { afterEach, describe, expect, it, jest } from '@jest/globals';
const mockGetUserFromAuth = (
  jest.requireMock('@kilocode/web-shared/lib/user/server') as { getUserFromAuth: jest.Mock }
).getUserFromAuth;
const mockEvaluateStepUp = (
  jest.requireMock('@kilocode/web-shared/lib/admin/step-up-store') as {
    evaluateStepUp: jest.Mock;
  }
).evaluateStepUp;
const originalSwitch = process.env.ADMIN_STEP_UP_ENABLED;

import type { requireAdminPage as requireAdminPageFn } from './require-admin-page';
type RequireAdminPage = typeof requireAdminPageFn;
let requireAdminPage!: RequireAdminPage;

const user = {
  id: 'admin-1',
  is_admin: true,
  google_user_email: 'admin@example.com',
  web_session_pepper: 'pepper',
};

beforeAll(async () => {
  ({ requireAdminPage } = await import('./require-admin-page'));
});

afterEach(() => {
  process.env.ADMIN_STEP_UP_ENABLED = originalSwitch;
  jest.clearAllMocks();
});

describe('requireAdminPage', () => {
  it('redirects a real non-admin to unauthorized', async () => {
    mockGetUserFromAuth.mockResolvedValue({ user: null } as never);

    await expect(requireAdminPage()).rejects.toThrow('NEXT_REDIRECT:/admin/unauthorized');
  });

  it('returns the user when the switch is off', async () => {
    process.env.ADMIN_STEP_UP_ENABLED = 'false';
    mockGetUserFromAuth.mockResolvedValue({ user, credential: 'session' } as never);

    await expect(requireAdminPage()).resolves.toEqual({ user, stepUp: null });
    expect(mockEvaluateStepUp).not.toHaveBeenCalled();
  });

  it('returns the user with a fresh proof when on', async () => {
    process.env.ADMIN_STEP_UP_ENABLED = 'true';
    mockGetUserFromAuth.mockResolvedValue({
      user,
      credential: 'session',
      webSessionId: 'session-1',
    } as never);
    mockEvaluateStepUp.mockResolvedValue({
      state: {
        status: 'fresh',
        method: 'webauthn_uv',
        verifiedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      proof: null,
      passkeyCount: 1,
    } as never);

    await expect(requireAdminPage()).resolves.toEqual({ user, stepUp: null });
  });

  it('returns a gate instead of redirecting when the session needs step-up', async () => {
    process.env.ADMIN_STEP_UP_ENABLED = 'true';
    mockGetUserFromAuth.mockResolvedValue({
      user,
      credential: 'session',
      webSessionId: 'session-1',
    } as never);
    mockEvaluateStepUp.mockResolvedValue({
      state: { status: 'required' },
      proof: null,
      passkeyCount: 1,
    } as never);

    await expect(requireAdminPage()).resolves.toEqual({
      user: null,
      stepUp: { code: 'MFA_REQUIRED' },
    });
  });

  it('fails closed on an evaluation error', async () => {
    process.env.ADMIN_STEP_UP_ENABLED = 'true';
    mockGetUserFromAuth.mockResolvedValue({
      user,
      credential: 'session',
      webSessionId: 'session-1',
    } as never);
    mockEvaluateStepUp.mockRejectedValue(new Error('db down') as never);

    await expect(requireAdminPage()).resolves.toEqual({
      user: null,
      stepUp: { code: 'STEP_UP_UNAVAILABLE' },
    });
  });
});
