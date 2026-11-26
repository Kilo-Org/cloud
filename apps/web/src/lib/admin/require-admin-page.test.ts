jest.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
}));

import { afterEach, describe, expect, it, jest } from '@jest/globals';
const mockGetUserFromAuth = (
  jest.requireMock('@kilocode/web-shared/lib/user/server') as { getUserFromAuth: jest.Mock }
).getUserFromAuth;

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
  jest.clearAllMocks();
});

describe('requireAdminPage', () => {
  it('runs the same server-component admission as the layout', async () => {
    mockGetUserFromAuth.mockResolvedValue({ user, credential: 'session' } as never);

    await expect(requireAdminPage()).resolves.toEqual({ user, stepUp: null });
    expect(mockGetUserFromAuth).toHaveBeenCalledWith({
      adminOnly: true,
      stepUpSurface: 'server-component',
    });
  });

  it('redirects a real non-admin to unauthorized', async () => {
    mockGetUserFromAuth.mockResolvedValue({ user: null } as never);

    await expect(requireAdminPage()).rejects.toThrow('NEXT_REDIRECT:/admin/unauthorized');
  });

  it('redirects an admin the network refused', async () => {
    mockGetUserFromAuth.mockResolvedValue({
      user: null,
      adminNetworkDenial: 'outside-allowlist',
    } as never);

    await expect(requireAdminPage()).rejects.toThrow('NEXT_REDIRECT:/admin/unauthorized');
  });

  it.each(['MFA_REQUIRED', 'SESSION_UNBOUND', 'BEARER_NOT_ALLOWED', 'STEP_UP_UNAVAILABLE'])(
    'returns a gate instead of redirecting for %s',
    async code => {
      mockGetUserFromAuth.mockResolvedValue({
        user: null,
        stepUp: {
          code,
          actionClass: 'platform_read',
          purpose: 'session',
          maxAgeSeconds: 1800,
          binding: null,
        },
      } as never);

      await expect(requireAdminPage()).resolves.toEqual({ user: null, stepUp: { code } });
    }
  );
});
