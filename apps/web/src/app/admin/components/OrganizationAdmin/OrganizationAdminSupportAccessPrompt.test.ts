import { beforeAll, describe, expect, it, jest } from '@jest/globals';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OrganizationAdminSupportAccessPrompt as PromptComponent } from './OrganizationAdminSupportAccessPrompt';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

let mockViewAccess: { grantRequired: boolean } | undefined;

jest.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: mockViewAccess }),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));
jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    admin: { supportAccess: { viewAccess: { queryOptions: () => ({ queryKey: ['view'] }) } } },
  }),
}));
jest.mock('@/app/admin/api/organizations/hooks', () => ({
  useAdminOrganizationDetails: () => ({ data: { name: 'Acme Child' } }),
}));
jest.mock('@/components/organizations/SupportAccessRequestDialog', () => ({
  SupportAccessRequestDialog: () => null,
}));

let Prompt: typeof PromptComponent;

beforeAll(async () => {
  ({ OrganizationAdminSupportAccessPrompt: Prompt } =
    await import('./OrganizationAdminSupportAccessPrompt'));
});

function render() {
  return renderToStaticMarkup(createElement(Prompt, { organizationId: 'org-1' }));
}

describe('OrganizationAdminSupportAccessPrompt', () => {
  it('prompts for access when a grant is required', () => {
    mockViewAccess = { grantRequired: true };
    const html = render();
    expect(html).toContain('Support access needed');
    expect(html).toContain('Acme Child');
    expect(html).toContain('Request access');
  });

  it('renders nothing when no grant is required', () => {
    mockViewAccess = { grantRequired: false };
    expect(render()).toBe('');
  });

  it('renders nothing while access is unknown', () => {
    mockViewAccess = undefined;
    expect(render()).toBe('');
  });
});
