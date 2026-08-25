import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { OrganizationChildOrganizationsCardView } from './OrganizationChildOrganizationsCard';

const organizationId = '4d2f6bf9-9a5e-4614-8e5e-39e68d747acd';

describe('OrganizationChildOrganizationsCard', () => {
  test('shows a setup path when the organization has no children', () => {
    const html = renderToStaticMarkup(
      React.createElement(OrganizationChildOrganizationsCardView, {
        organizationId,
        childOrganizations: [],
        isLoading: false,
      })
    );

    expect(html).toContain('Create sub-organizations to manage teams');
    expect(html).toContain('Set up sub-organizations');
    expect(html).toContain(`/organizations/${organizationId}/sub-organizations`);
  });

  test('keeps the existing child summary and management path', () => {
    const html = renderToStaticMarkup(
      React.createElement(OrganizationChildOrganizationsCardView, {
        organizationId,
        childOrganizations: [{ id: 'fdd1dc02-8a2d-4d8d-a24d-51b7cf7f5b8e', name: 'Child One' }],
        isLoading: false,
      })
    );

    expect(html).toContain('1 sub-organization belongs to this organization');
    expect(html).toContain('Child One');
    expect(html).toContain('Manage sub-organizations');
  });
});
