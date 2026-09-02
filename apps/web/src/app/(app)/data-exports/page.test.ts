import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const mockGetUserFromAuthOrRedirect = jest.fn();
const mockIsCloudDataExportUIEnabled = jest.fn();

(globalThis as typeof globalThis & { React: typeof React }).React = React;

jest.mock('@/lib/user/server', () => ({
  getUserFromAuthOrRedirect: mockGetUserFromAuthOrRedirect,
}));
jest.mock('@/lib/user-data-export-ui', () => ({
  isCloudDataExportUIEnabled: mockIsCloudDataExportUIEnabled,
}));
jest.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
jest.mock('@/components/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('./DataExportsClient', () => ({ DataExportsClient: () => 'Export controls' }));
jest.mock('./RequestDataDeletionCard', () => ({
  RequestDataDeletionCard: () => 'Deletion support',
}));

describe('DataExportsPage', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockGetUserFromAuthOrRedirect.mockResolvedValue({
      id: 'user-1',
      google_user_email: 'export-user@example.com',
      is_admin: false,
    });
  });

  it('redirects unauthenticated visitors before evaluating the flag', async () => {
    mockGetUserFromAuthOrRedirect.mockRejectedValue(new Error('NEXT_REDIRECT'));
    const { default: DataExportsPage } = await import('./page');

    await expect(DataExportsPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(mockGetUserFromAuthOrRedirect).toHaveBeenCalledWith(
      '/users/sign_in?callbackPath=/data-exports'
    );
    expect(mockIsCloudDataExportUIEnabled).not.toHaveBeenCalled();
  });

  it('preserves the page for an enabled non-admin user', async () => {
    mockIsCloudDataExportUIEnabled.mockResolvedValue(true);
    const { default: DataExportsPage } = await import('./page');

    const html = renderToStaticMarkup(await DataExportsPage());

    expect(html).toContain('Export controls');
    expect(html).toContain('Deletion support');
    expect(mockIsCloudDataExportUIEnabled).toHaveBeenCalledWith('export-user@example.com');
  });

  it.each([false, undefined])('rejects direct access when the flag is %s', async enabled => {
    mockIsCloudDataExportUIEnabled.mockResolvedValue(enabled);
    const { default: DataExportsPage } = await import('./page');

    await expect(DataExportsPage()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('does not render while the flag evaluation is pending', async () => {
    const flag = Promise.withResolvers<boolean>();
    mockIsCloudDataExportUIEnabled.mockReturnValue(flag.promise);
    const { default: DataExportsPage } = await import('./page');
    const rendered = jest.fn();
    const result = DataExportsPage().then(rendered);

    await Promise.resolve();
    expect(mockIsCloudDataExportUIEnabled).toHaveBeenCalled();
    expect(rendered).not.toHaveBeenCalled();

    flag.resolve(false);
    await expect(result).rejects.toThrow('NEXT_NOT_FOUND');
    expect(rendered).not.toHaveBeenCalled();
  });

  it('does not bypass the flag for staff', async () => {
    mockGetUserFromAuthOrRedirect.mockResolvedValue({
      id: 'admin-1',
      google_user_email: 'staff@example.com',
      is_admin: true,
    });
    mockIsCloudDataExportUIEnabled.mockResolvedValue(false);
    const { default: DataExportsPage } = await import('./page');

    await expect(DataExportsPage()).rejects.toThrow('NEXT_NOT_FOUND');
  });
});
