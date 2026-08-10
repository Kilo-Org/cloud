import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import DataExportDetailPage from './page';

jest.mock('./DataExportDetailContent', () => ({
  DataExportDetailContent: ({ exportId }: { exportId: string }) =>
    React.createElement('div', null, exportId),
}));
jest.mock('@/app/admin/components/AdminPage', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) =>
    React.createElement('main', null, children),
}));
jest.mock('@/components/ui/breadcrumb', () => ({
  BreadcrumbItem: ({ children }: { children: React.ReactNode }) =>
    React.createElement('span', null, children),
  BreadcrumbLink: ({ children }: { children: React.ReactNode }) =>
    React.createElement('span', null, children),
  BreadcrumbPage: ({ children }: { children: React.ReactNode }) =>
    React.createElement('span', null, children),
  BreadcrumbSeparator: () => null,
}));

describe('DataExportDetailPage', () => {
  it('passes malformed route parameters to validation without decoding again', async () => {
    const html = renderToStaticMarkup(
      await DataExportDetailPage({ params: Promise.resolve({ id: 'bad%identifier' }) })
    );

    expect(html).toContain('bad%identifier');
  });
});
