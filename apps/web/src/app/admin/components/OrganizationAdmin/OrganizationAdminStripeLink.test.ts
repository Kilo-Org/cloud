import { beforeAll, describe, expect, it, jest } from '@jest/globals';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OrganizationAdminStripeLink as StripeLinkComponent } from './OrganizationAdminStripeLink';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

let mockDetails: { stripe_customer_id: string | null } | undefined;

jest.mock('@/app/admin/api/organizations/hooks', () => ({
  useAdminOrganizationDetails: () => ({ data: mockDetails }),
}));

let StripeLink: typeof StripeLinkComponent;

beforeAll(async () => {
  ({ OrganizationAdminStripeLink: StripeLink } = await import('./OrganizationAdminStripeLink'));
});

function render() {
  return renderToStaticMarkup(createElement(StripeLink, { organizationId: 'org-1' }));
}

describe('OrganizationAdminStripeLink', () => {
  it('links to the Stripe customer from admin details', () => {
    mockDetails = { stripe_customer_id: 'cus_test123' };
    const html = render();
    expect(html).toContain('cus_test123');
    expect(html).toContain('customers/cus_test123');
    expect(html).toContain('View in Stripe');
  });

  it('renders nothing without a Stripe customer', () => {
    mockDetails = { stripe_customer_id: null };
    expect(render()).toBe('');
  });
});
