import type { ReactNode } from 'react';

import { redirect } from 'next/navigation';
import { AuthorizedSubOrganizationsLayout } from './layout';

jest.mock('next/navigation', () => ({
  redirect: jest.fn(),
}));

describe('AuthorizedSubOrganizationsLayout', () => {
  test('allows a parent organization without existing children', () => {
    const children: ReactNode = 'sub-organizations content';

    expect(
      AuthorizedSubOrganizationsLayout({
        organizationId: '4d2f6bf9-9a5e-4614-8e5e-39e68d747acd',
        parentOrganizationId: null,
        children,
      })
    ).toBe(children);
    expect(redirect).not.toHaveBeenCalled();
  });

  test('redirects child organizations', () => {
    expect(
      AuthorizedSubOrganizationsLayout({
        organizationId: '4d2f6bf9-9a5e-4614-8e5e-39e68d747acd',
        parentOrganizationId: 'fdd1dc02-8a2d-4d8d-a24d-51b7cf7f5b8e',
        children: 'sub-organizations content',
      })
    ).toBe('sub-organizations content');

    expect(redirect).toHaveBeenCalledWith('/organizations/4d2f6bf9-9a5e-4614-8e5e-39e68d747acd');
  });
});
