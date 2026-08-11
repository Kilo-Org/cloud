import React from 'react';

const mockGetUserFromAuth = jest.fn();
const mockNotFound = jest.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});

(globalThis as typeof globalThis & { React: typeof React }).React = React;

jest.mock('@/lib/user/server', () => ({ getUserFromAuth: mockGetUserFromAuth }));
jest.mock('next/navigation', () => ({ notFound: mockNotFound }));
jest.mock('./DataExportsClient', () => ({ DataExportsClient: () => null }));

describe('DataExportsPage', () => {
  it('requires Kilo admin authentication', async () => {
    mockGetUserFromAuth.mockResolvedValue({ user: null });
    const { default: DataExportsPage } = await import('./page');

    await expect(DataExportsPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockGetUserFromAuth).toHaveBeenCalledWith({ adminOnly: true });
  });
});
