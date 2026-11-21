import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OrganizationGitHubInstallations } from './OrganizationGitHubInstallations';

let mockRole: 'workflow' | 'agent_only' | null | undefined = 'workflow';
let mockStatus = 'connected';
let mockPendingApprovalStatus: 'awaiting_installation' | 'blocked_by_existing_installation' | null =
  null;
const previousReact = Reflect.get(globalThis, 'React');
beforeAll(() => Object.assign(globalThis, { React }));
afterAll(() => {
  if (previousReact === undefined) Reflect.deleteProperty(globalThis, 'React');
  else Reflect.set(globalThis, 'React', previousReact);
});

jest.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
jest.mock('@/app/api/organizations/hooks', () => ({
  useOrganizationWithMembers: () => ({ data: { name: 'Test org', settings: {} } }),
}));
jest.mock('@/lib/hooks/use-openrouter-models', () => ({
  useModelSelectorList: () => ({ data: { data: [] }, isLoading: false }),
}));
jest.mock('@/components/ui/confirm', () => ({ useConfirm: () => jest.fn() }));
jest.mock('@/components/shared/ModelCombobox', () => ({
  ModelCombobox: ({ helperText, disabled }: { helperText: string; disabled: boolean }) =>
    React.createElement(
      'div',
      { 'data-testid': 'github-model-selector', 'data-model-disabled': String(disabled) },
      helperText
    ),
}));
jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    githubApps: Object.fromEntries(
      [
        'listOrganizationInstallations',
        'getConnectionAttempt',
        'refreshInstallation',
        'updateModel',
        'uninstallApp',
        'disconnectConnection',
        'cancelPendingInstallation',
        'mintInstallState',
        'beginConnection',
        'selectConnectionInstallation',
      ].map(name => [
        name,
        { queryOptions: () => ({ fixture: name }), mutationOptions: () => ({}) },
      ])
    ),
  }),
}));
jest.mock('@tanstack/react-query', () => ({
  useQuery: ({ fixture }: { fixture: string }) => ({
    isLoading: false,
    data:
      fixture === 'listOrganizationInstallations'
        ? {
            connectionManagementEnabled: true,
            canManageConnections: true,
            canInstallAdditional: false,
            installations: [
              {
                id: 'installation-1',
                accountLogin: 'acme',
                status: mockStatus,
                connectionRole: mockRole,
                modelSlug: null,
                repositorySelection: 'all',
                repositories: [],
                canManageModel: true,
                canDisconnect: true,
                canUninstall: false,
                pendingApprovalStatus: mockPendingApprovalStatus,
              },
            ],
          }
        : undefined,
  }),
  useMutation: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));

test('workflow model help remains scoped to GitHub bot usage', () => {
  mockRole = 'workflow';
  mockStatus = 'connected';
  const html = renderToStaticMarkup(
    React.createElement(OrganizationGitHubInstallations, { organizationId: 'org-1' })
  );
  expect(html).toContain('GitHub bot mentions');
  expect(html).toContain('data-model-disabled="false"');
  expect(html).not.toContain('Access unavailable');
});

test('agent-only model help points to actual Slack and Cloud Agent model selection', () => {
  mockRole = 'agent_only';
  mockStatus = 'connected';
  const html = renderToStaticMarkup(
    React.createElement(OrganizationGitHubInstallations, { organizationId: 'org-1' })
  );
  expect(html).toContain('Agent access');
  expect(html).toContain('Choose the Slack model in Slack integration settings');
  expect(html).toContain('Cloud Agent model in the session');
  expect(html).not.toContain('github-model-selector');
  expect(html).not.toContain('GitHub bot mentions');
});

test.each([null, undefined])(
  'unassigned role %s is explicitly unavailable rather than described as agent-only',
  role => {
    mockRole = role;
    mockStatus = 'connected';
    const html = renderToStaticMarkup(
      React.createElement(OrganizationGitHubInstallations, { organizationId: 'org-1' })
    );
    expect(html).toContain('Access unavailable');
    expect(html).toContain('needs role reconciliation');
    expect(html).not.toContain('github-model-selector');
    expect(html).not.toContain('GitHub bot mentions');
    expect(html).not.toContain('Slack and Cloud Agent only');
  }
);

test('disconnected agent access is not represented as currently available', () => {
  mockRole = 'agent_only';
  mockStatus = 'disconnected';
  mockPendingApprovalStatus = null;
  const html = renderToStaticMarkup(
    React.createElement(OrganizationGitHubInstallations, { organizationId: 'org-1' })
  );
  expect(html).not.toContain('Agent access</span>');
  expect(html).toContain('Disconnected from this Kilo organization');
  expect(html).toContain('access is unavailable until fresh verification');
  expect(html).not.toContain('github-model-selector');
});

test('a request blocked by the organization installation states the remedy', () => {
  mockRole = null;
  mockStatus = 'pending';
  mockPendingApprovalStatus = 'blocked_by_existing_installation';
  const html = renderToStaticMarkup(
    React.createElement(OrganizationGitHubInstallations, { organizationId: 'org-1' })
  );
  expect(html).toContain('Pending approval');
  expect(html).toContain('This organization already has a GitHub installation, so this request');
  expect(html).toContain('Remove that installation in Kilo (Disconnect, or Uninstall GitHub App)');
  expect(html).toContain('cancel this request and start the connection again');
});

test('a request still awaiting installation carries no blocking remedy', () => {
  mockRole = null;
  mockStatus = 'pending';
  mockPendingApprovalStatus = 'awaiting_installation';
  const html = renderToStaticMarkup(
    React.createElement(OrganizationGitHubInstallations, { organizationId: 'org-1' })
  );
  expect(html).toContain('Pending approval');
  expect(html).not.toContain('already has a GitHub installation');
});
