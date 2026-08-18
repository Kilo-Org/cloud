import React from 'react';

const mockGetUserFromAuthOrRedirect = jest.fn();

(globalThis as typeof globalThis & { React: typeof React }).React = React;

jest.mock('@/lib/user/server', () => ({
  getUserFromAuthOrRedirect: mockGetUserFromAuthOrRedirect,
}));
jest.mock('@/components/PageLayout', () => ({ PageLayout: () => null }));
jest.mock('./DataExportsClient', () => ({ DataExportsClient: () => null }));
jest.mock('./RequestDataDeletionCard', () => ({ RequestDataDeletionCard: () => null }));

describe('DataExportsPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('redirects unauthenticated visitors to sign in and returns them to data exports', async () => {
    mockGetUserFromAuthOrRedirect.mockRejectedValue(new Error('NEXT_REDIRECT'));
    const { default: DataExportsPage } = await import('./page');

    await expect(DataExportsPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(mockGetUserFromAuthOrRedirect).toHaveBeenCalledWith(
      '/users/sign_in?callbackPath=/data-exports'
    );
  });

  it('renders for a signed-in non-admin user', async () => {
    mockGetUserFromAuthOrRedirect.mockResolvedValue({ id: 'user-1', is_admin: false });
    const { default: DataExportsPage } = await import('./page');

    await expect(DataExportsPage()).resolves.toBeTruthy();
    expect(mockGetUserFromAuthOrRedirect).toHaveBeenCalledWith(
      '/users/sign_in?callbackPath=/data-exports'
    );
  });
});
