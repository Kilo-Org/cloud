import React from 'react';

const mockGetUserFromAuth = jest.fn();
const mockNotFound = jest.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});

(globalThis as typeof globalThis & { React: typeof React }).React = React;

jest.mock('@/lib/user/server', () => ({ getUserFromAuth: mockGetUserFromAuth }));
jest.mock('next/navigation', () => ({ notFound: mockNotFound }));
jest.mock('@/components/PageLayout', () => ({ PageLayout: () => null }));
jest.mock('./DataExportsClient', () => ({ DataExportsClient: () => null }));
jest.mock('./RequestDataDeletionCard', () => ({ RequestDataDeletionCard: () => null }));

describe('DataExportsPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('authenticates the visitor without requiring Kilo staff', async () => {
    mockGetUserFromAuth.mockResolvedValue({ user: null });
    const { default: DataExportsPage } = await import('./page');

    await expect(DataExportsPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockGetUserFromAuth).toHaveBeenCalledWith({ adminOnly: false });
  });

  it('renders for a signed-in non-admin user', async () => {
    mockGetUserFromAuth.mockResolvedValue({ user: { id: 'user-1', is_admin: false } });
    const { default: DataExportsPage } = await import('./page');

    await expect(DataExportsPage()).resolves.toBeTruthy();
    expect(mockNotFound).not.toHaveBeenCalled();
  });
});
