import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OrganizationGitHubInstallations } from './OrganizationGitHubInstallations';

let mockRole: 'workflow' | 'agent_only' | null | undefined = 'workflow';
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
jest.mock('@/app/api/openrouter/hooks', () => ({
  useModelSelectorList: () => ({ data: { data: [] }, isLoading: false }),
}));
jest.mock('@/components/ui/confirm', () => ({ useConfirm: () => jest.fn() }));
jest.mock('@/components/shared/ModelCombobox', () => ({
  ModelCombobox: ({ helperText, disabled }: { helperText: string; disabled: boolean }) =>
    React.createElement('div', { 'data-model-disabled': String(disabled) }, helperText),
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
                status: 'connected',
                connectionRole: mockRole,
                modelSlug: null,
                repositorySelection: 'all',
                repositories: [],
                canManageModel: true,
                canDisconnect: true,
                canUninstall: false,
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
  const html = renderToStaticMarkup(
    React.createElement(OrganizationGitHubInstallations, { organizationId: 'org-1' })
  );
  expect(html).toContain('GitHub bot mentions');
  expect(html).toContain('data-model-disabled="false"');
  expect(html).not.toContain('Access unavailable');
});

test('agent-only model help points to actual Slack and Cloud Agent model selection', () => {
  mockRole = 'agent_only';
  const html = renderToStaticMarkup(
    React.createElement(OrganizationGitHubInstallations, { organizationId: 'org-1' })
  );
  expect(html).toContain('Agent access');
  expect(html).toContain('Choose the Slack model in Slack integration settings');
  expect(html).toContain('Cloud Agent model in the session');
  expect(html).not.toContain('GitHub bot mentions');
});

test.each([null, undefined])(
  'unassigned role %s is explicitly unavailable rather than described as agent-only',
  role => {
    mockRole = role;
    const html = renderToStaticMarkup(
      React.createElement(OrganizationGitHubInstallations, { organizationId: 'org-1' })
    );
    expect(html).toContain('Access unavailable');
    expect(html).toContain('needs role reconciliation');
    expect(html).toContain('data-model-disabled="true"');
    expect(html).not.toContain('GitHub bot mentions');
    expect(html).not.toContain('Slack and Cloud Agent only');
  }
);
