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
jest.mock('@/components/PageLayout', () => ({
  PageLayout: ({
    children,
    title,
    subtitle,
  }: {
    children: React.ReactNode;
    title: string;
    subtitle: string;
  }) =>
    React.createElement(
      'main',
      null,
      React.createElement('h1', null, title),
      React.createElement('p', null, subtitle),
      children
    ),
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

    expect(html).toContain('<h1>Data exports</h1>');
    expect(html).toContain(
      'Request and download a copy of the data stored with your Kilo account.'
    );
    expect(html).toContain('Export controls');
    expect(html).toContain('Deletion support');
    expect(mockIsCloudDataExportUIEnabled).toHaveBeenCalledWith('export-user@example.com');
  });

  it.each([false, undefined])(
    'preserves deletion without export controls when the flag is %s',
    async enabled => {
      mockIsCloudDataExportUIEnabled.mockResolvedValue(enabled);
      const { default: DataExportsPage } = await import('./page');

      const html = renderToStaticMarkup(await DataExportsPage());

      expect(html).toContain('<h1>Data deletion</h1>');
      expect(html).toContain('Deletion support');
      expect(html).not.toContain('Export controls');
      expect(html).not.toContain('Request and download a copy');
    }
  );

  it('does not render while the flag evaluation is pending', async () => {
    const flag = Promise.withResolvers<boolean>();
    mockIsCloudDataExportUIEnabled.mockReturnValue(flag.promise);
    const { default: DataExportsPage } = await import('./page');
    const rendered = jest.fn(renderToStaticMarkup);
    const result = DataExportsPage().then(rendered);

    await Promise.resolve();
    expect(mockIsCloudDataExportUIEnabled).toHaveBeenCalled();
    expect(rendered).not.toHaveBeenCalled();

    flag.resolve(false);
    const html = await result;
    expect(html).toContain('Deletion support');
    expect(html).not.toContain('Export controls');
  });

  it('does not bypass the flag for staff', async () => {
    mockGetUserFromAuthOrRedirect.mockResolvedValue({
      id: 'admin-1',
      google_user_email: 'staff@example.com',
      is_admin: true,
    });
    mockIsCloudDataExportUIEnabled.mockResolvedValue(false);
    const { default: DataExportsPage } = await import('./page');

    const html = renderToStaticMarkup(await DataExportsPage());
    expect(html).toContain('Deletion support');
    expect(html).not.toContain('Export controls');
  });
});
