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

// `.test.ts`, not `.test.tsx`: jest's testMatch is `**/src/**/*.test.ts`, so a `.tsx`
// suite is silently never collected. An earlier version of this file was a `.tsx` and
// never ran, which is how its deletion went unnoticed.
describe('DataExportsPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('authenticates the visitor without requiring Kilo staff', async () => {
    mockGetUserFromAuth.mockResolvedValue({ user: null });
    const { default: DataExportsPage } = await import('./page');

    await expect(DataExportsPage()).rejects.toThrow('NEXT_NOT_FOUND');
    // `adminOnly: false` is the whole guard: signed out is still refused, but a signed-in
    // non-staff user reaches the page. Asserted explicitly so a regression to
    // `adminOnly: true` fails here rather than silently hiding the page from users.
    expect(mockGetUserFromAuth).toHaveBeenCalledWith({ adminOnly: false });
  });

  it('renders for a signed-in user who is not a Kilo admin', async () => {
    mockGetUserFromAuth.mockResolvedValue({ user: { id: 'user-1', is_admin: false } });
    const { default: DataExportsPage } = await import('./page');

    await expect(DataExportsPage()).resolves.toBeTruthy();
    expect(mockNotFound).not.toHaveBeenCalled();
  });
});
