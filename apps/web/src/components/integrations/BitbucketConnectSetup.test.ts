import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getUnexpectedBitbucketWorkspaceAccessTokenScopes } from '@kilocode/worker-utils/bitbucket-workspace-access-token';
import {
  BitbucketConnectSetup,
  buildConnectedWorkspaceAccessTokenStatus,
} from './BitbucketConnectSetup';

jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    organizations: {
      bitbucket: {
        getStatus: { queryKey: () => ['status'] },
        connect: { mutationOptions: (options: object) => options },
      },
      cloudAgentNext: { listBitbucketRepositories: { queryKey: () => ['repositories'] } },
      reviewAgent: { getBitbucketReadiness: { queryKey: () => ['readiness'] } },
    },
  }),
}));

// Match the repository's classic JSX Jest transform without replacing the shipped components.
Object.assign(globalThis, { React });

function render(canManage = true, statusRefetchFailed = false) {
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(BitbucketConnectSetup, {
        organizationId: 'organization-1',
        canManage,
        statusRefetchFailed,
      })
    )
  );
}

it('AC1 keeps the exact workspace connected after replacing the token with write grants', () => {
  const status = buildConnectedWorkspaceAccessTokenStatus(
    {
      integrationId: 'integration-1',
      workspace: { uuid: '{workspace-1}', slug: 'acme', displayName: 'Acme Workspace' },
      credentialVersion: 2,
      repositoryCount: 1,
      validatedAt: '2026-08-30T09:00:00.000Z',
      unexpectedScopes: getUnexpectedBitbucketWorkspaceAccessTokenScopes([
        'account',
        'pullrequest:write',
        'webhook',
      ]),
    },
    true
  );
  expect(status).toMatchObject({
    status: 'connected',
    method: 'workspace_access_token',
    integrationId: 'integration-1',
    workspace: { uuid: '{workspace-1}', slug: 'acme', displayName: 'Acme Workspace' },
    lastValidatedAt: '2026-08-30T09:00:00.000Z',
    unexpectedScopes: [],
    recoveryAction: null,
    canManage: true,
    repositoryCache: { status: 'uninitialized', repositories: [], syncedAt: null },
  });
});

it('AC1 explains write recovery while keeping the empty connection form usable', () => {
  const html = render();
  expect(html).toContain('<li>Pull request Write</li>');
  expect(html).toContain('Existing Pull request Read connections remain readable');
  expect(html).toContain('replace the workspace token');
  expect(html).toContain('reconnect with OAuth');
  expect(html).toContain('the Kilo operator must enable Pull request Write');
  expect(html).toContain('Bitbucket OAuth consumer');
  expect(html).toContain('configuration requirement, not a Bitbucket review limitation');
  expect(html).toContain('for="bitbucket-workspace-token"');
  expect(html).toContain('id="bitbucket-review-permissions"');
  expect(html).toContain(
    'aria-describedby="bitbucket-workspace-token-help bitbucket-review-permissions"'
  );
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Connect workspace<\/button>/);
});

it('AC1 retains the connection form after a retryable status refresh failure', () => {
  const html = render(true, true);
  expect(html).toContain('Bitbucket status could not be refreshed');
  expect(html).toContain('Showing the last loaded integration status');
  expect(html).toContain('id="bitbucket-workspace-token"');
});

it('AC1 explains management denial without an unauthorized connection action', () => {
  const html = render(false);
  expect(html).toContain('An organization owner or billing manager can connect');
  expect(html).not.toContain('id="bitbucket-workspace-token"');
  expect(html).not.toContain('Connect with Bitbucket OAuth');
});
