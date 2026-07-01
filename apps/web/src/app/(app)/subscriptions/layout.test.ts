import type { ReactNode } from 'react';
import type { User } from '@kilocode/db/schema';
import { defineTestUser } from '@/tests/helpers/user.helper';

const mockGetUserFromAuthOrRedirect = jest.fn<Promise<User>, []>();

jest.mock('@/lib/user/server', () => ({
  getUserFromAuthOrRedirect: () => mockGetUserFromAuthOrRedirect(),
}));

describe('SubscriptionsLayout', () => {
  const redirectSentinel = new Error('NEXT_REDIRECT');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders subscription pages when authenticated', async () => {
    mockGetUserFromAuthOrRedirect.mockResolvedValue(defineTestUser());

    const { default: SubscriptionsLayout } = await import('@/app/(app)/subscriptions/layout');
    const children = 'subscriptions content' as ReactNode;

    await expect(SubscriptionsLayout({ children })).resolves.toBe(children);
    expect(mockGetUserFromAuthOrRedirect).toHaveBeenCalledTimes(1);
  });

  it('propagates a redirect sentinel when unauthenticated', async () => {
    mockGetUserFromAuthOrRedirect.mockRejectedValue(redirectSentinel);

    const { default: SubscriptionsLayout } = await import('@/app/(app)/subscriptions/layout');
    const children = 'subscriptions content' as ReactNode;

    await expect(SubscriptionsLayout({ children })).rejects.toBe(redirectSentinel);
    expect(mockGetUserFromAuthOrRedirect).toHaveBeenCalledTimes(1);
  });
});
