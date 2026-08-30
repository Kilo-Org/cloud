import React, { createElement, type ComponentProps, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider, skipToken } from '@tanstack/react-query';
import type * as DialogPrimitive from '@radix-ui/react-dialog';
import { buildConnectedWorkspaceAccessTokenStatus } from '@/components/integrations/BitbucketConnectSetup';
import {
  BitbucketAdditionalPermissionsWarning,
  getRecoveryGuidance,
} from '@/components/integrations/BitbucketConnectedManagement';
import {
  BitbucketConnectionRedirectNotice,
  BitbucketIntegrationDetails,
  getBitbucketConnectionErrorMessage,
} from '@/components/integrations/BitbucketIntegrationDetails';
import { getBitbucketIntegrationControlsDescription } from '@/components/integrations/BitbucketIntegrationControls';

jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    organizations: {
      bitbucket: {
        getStatus: {
          queryKey: () => ['status'],
          queryOptions: () => ({ queryKey: ['status'], queryFn: skipToken }),
        },
        connect: { mutationOptions: (options: object) => options },
        replaceToken: { mutationOptions: (options: object) => options },
        refreshRepositories: { mutationOptions: (options: object) => options },
        disconnect: { mutationOptions: () => ({}) },
      },
      cloudAgentNext: { listBitbucketRepositories: { queryKey: () => ['repositories'] } },
      reviewAgent: { getBitbucketReadiness: { queryKey: () => ['readiness'] } },
    },
  }),
}));

let mockOpenDialogs = false;

// Render the real dialog content inline for the Node renderer; E13 checks live interaction.
jest.mock('@radix-ui/react-dialog', () => {
  const actual = jest.requireActual<typeof DialogPrimitive>('@radix-ui/react-dialog');
  return {
    ...actual,
    Root: (props: ComponentProps<typeof actual.Root>) =>
      createElement(actual.Root, { ...props, open: mockOpenDialogs || props.open }),
    Portal: ({ children }: { children: ReactNode }) => children,
  };
});

// Match the repository's classic JSX Jest transform without replacing the shipped components.
Object.assign(globalThis, { React });

type BitbucketStatus = ReturnType<typeof buildConnectedWorkspaceAccessTokenStatus>;

function connectedStatus() {
  return {
    status: 'connected',
    recoveryAction: null,
    method: 'workspace_access_token',
    integrationId: '33333333-3333-4333-8333-333333333333',
    integrationStatus: 'active',
    workspace: {
      uuid: '11111111-1111-4111-8111-111111111111',
      slug: 'acme',
      displayName: 'Acme Workspace',
    },
    invalidatedAt: null,
    invalidationReason: null,
    lastValidatedAt: '2026-08-30T09:00:00.000Z',
    unexpectedScopes: [],
    repositoryCache: {
      status: 'available',
      syncedAt: '2026-08-30T09:00:00.000Z',
      repositories: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          workspaceUuid: '11111111-1111-4111-8111-111111111111',
          name: 'mobile',
          fullName: 'acme/mobile',
          private: true,
          defaultBranch: 'main',
        },
      ],
    },
    canManage: true,
  } satisfies BitbucketStatus;
}

function renderDetails(
  status: BitbucketStatus,
  {
    openDialogs = false,
    refetchFailed = false,
    error,
  }: { openDialogs?: boolean; refetchFailed?: boolean; error?: string } = {}
) {
  const client = new QueryClient();
  client.setQueryData(['status'], status);
  if (refetchFailed) {
    client
      .getQueryCache()
      .find({ queryKey: ['status'] })
      ?.setState({
        status: 'error',
        error: new Error('Temporary status failure'),
      });
  }
  mockOpenDialogs = openDialogs;
  try {
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(BitbucketIntegrationDetails, { organizationId: 'organization-1', error })
      )
    );
  } finally {
    mockOpenDialogs = false;
    client.clear();
  }
}

describe('Bitbucket integration UI state', () => {
  it('AC1 exposes write recovery from the connected parent without hiding repositories', () => {
    const html = renderDetails(connectedStatus());
    expect(html).toContain('Existing Pull request Read connections remain readable');
    expect(html).toContain('replace the workspace token with Pull request Write');
    expect(html).toContain('Replace token');
    expect(html).toContain('Acme Workspace');
    expect(html).toContain('acme/mobile');
    expect(html).toContain('Refresh repositories');
    expect(html).not.toContain('Not connected');
    expect(html).not.toContain('id="bitbucket-workspace-token"');
    expect(html).not.toContain('id="bitbucket-replacement-token"');
  });

  it('AC11 links required permissions to the replacement input through the connected parent', () => {
    const html = renderDetails(connectedStatus(), { openDialogs: true });
    const form = html.match(/<form\b[^>]*>[\s\S]*?<\/form>/)?.[0];
    expect(form).toBeDefined();
    const dialog = html.match(/<div\b[^>]*role="dialog"[^>]*>/)?.[0];
    expect(dialog).toContain('max-h-[calc(100dvh-2rem)]');
    expect(dialog).toContain('overflow-y-auto');
    expect(form).toContain('Replace Workspace Access Token');
    for (const permission of [
      'Account Read',
      'Repository Read',
      'Repository Write',
      'Pull request Write',
      'Webhooks Read and Write',
    ]) {
      expect(form).toContain(`<li>${permission}</li>`);
    }
    expect(form).toContain('id="bitbucket-replacement-permissions"');
    expect(form).toMatch(
      /<input[^>]*id="bitbucket-replacement-token"[^>]*aria-describedby="[^"]*bitbucket-replacement-permissions/
    );
    expect(form).toContain('Keep current token');
    expect(form).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>Replace token<\/button>/);
    expect(html).toContain('acme/mobile');
  });

  it('AC1 keeps replacement guidance and cached repositories after a retryable status failure', () => {
    const html = renderDetails(connectedStatus(), { openDialogs: true, refetchFailed: true });
    expect(html).toContain('Bitbucket status could not be refreshed');
    expect(html).toContain('Showing the last loaded workspace and repository cache');
    expect(html).toContain('acme/mobile');
    expect(html).toContain('id="bitbucket-replacement-token"');
    expect(html).toContain('<li>Pull request Write</li>');
    expect(html).toContain('Keep current token');
    expect(html).toContain('Replace token');
  });

  it('AC1 explains write permission recovery to non-managers without management controls', () => {
    const html = renderDetails({ ...connectedStatus(), canManage: false }, { openDialogs: true });
    expect(html).toContain('Pull request Write');
    expect(html).toContain('An organization owner or billing manager');
    expect(html).toContain('acme/mobile');
    expect(html).not.toContain('id="bitbucket-replacement-token"');
    expect(html).not.toContain('Replace token');
    expect(html).not.toContain('Disconnect Bitbucket');
  });

  it('AC1 exposes an actionable OAuth recovery link from the connected parent', () => {
    const status = {
      ...connectedStatus(),
      method: 'oauth',
      authorizingNickname: 'bucket-user',
    } satisfies BitbucketStatus;
    const html = renderDetails(status);
    const href = html.match(/<a\b[^>]*href="([^"]+)"[^>]*>Reconnect with OAuth<\/a>/)?.[1];
    expect(href).toBeDefined();
    const url = new URL(href?.replaceAll('&amp;', '&') ?? '', 'https://app.example');
    expect(url.pathname).toBe('/api/integrations/bitbucket/connect');
    expect(url.searchParams.get('organizationId')).toBe('organization-1');
    expect(url.searchParams.get('reconnectIntegrationId')).toBe(status.integrationId);
    expect(html).toContain('the Kilo operator must enable Pull request Write');
    expect(html).toContain('Bitbucket OAuth consumer');
    expect(html).toContain('bucket-user');
    expect(html).toContain('acme/mobile');
    expect(html).not.toContain('Replace token');
    expect(html).not.toContain('Choose workspace');
  });

  it.each(['authorization_cancelled', 'connection_failed', 'oauth_init_failed'])(
    'AC1 retains OAuth recovery and cached repositories after %s',
    error => {
      const html = renderDetails(
        { ...connectedStatus(), method: 'oauth', authorizingNickname: 'bucket-user' },
        { error }
      );
      expect(html).toContain(getBitbucketConnectionErrorMessage(error));
      expect(html).toContain('>Reconnect with OAuth</a>');
      expect(html).toContain('acme/mobile');
      expect(html).toContain('Acme Workspace');
      expect(html).toContain('Refresh repositories');
      expect(html).not.toContain('Not connected');
      expect(html).not.toContain('Choose workspace');
    }
  );

  it.each([
    ['connection_changed', 'Refresh this page'],
    ['workspace_unavailable', 'account with access to that workspace'],
    ['missing_scopes', 'Kilo operator'],
  ])('AC1 explains %s without replacing the connected presentation', (error, guidance) => {
    const html = renderDetails(
      { ...connectedStatus(), method: 'oauth', authorizingNickname: 'bucket-user' },
      { error }
    );
    expect(html).toContain(guidance);
    expect(html).toContain('acme/mobile');
    expect(html).toContain('>Reconnect with OAuth</a>');
    expect(html).not.toContain('Not connected');
  });

  it('AC1 denies OAuth recovery controls to non-managers while retaining repositories', () => {
    const html = renderDetails(
      {
        ...connectedStatus(),
        method: 'oauth',
        authorizingNickname: 'bucket-user',
        canManage: false,
      },
      { error: 'unauthorized' }
    );
    expect(html).toContain('Ask an owner or billing manager');
    expect(html).toContain('acme/mobile');
    expect(html).not.toContain('>Reconnect with OAuth</a>');
    expect(html).not.toContain('reconnectIntegrationId=');
    expect(html).not.toContain('Disconnect Bitbucket');
  });

  it('AC1 keeps the actual disconnected parent on the existing first-connect form', () => {
    const html = renderDetails({
      ...connectedStatus(),
      status: 'not_connected',
      integrationId: null,
      integrationStatus: null,
      workspace: null,
      lastValidatedAt: null,
      repositoryCache: { status: 'uninitialized', repositories: [], syncedAt: null },
    });
    expect(html).toContain('Not connected');
    expect(html).toContain('id="bitbucket-workspace-token"');
    expect(html).toContain('>Connect workspace</button>');
    expect(html).not.toContain('reconnectIntegrationId=');
    expect(html).not.toContain('Integration controls');
  });

  it('builds connected status from a successful Workspace Access Token mutation', () => {
    expect(
      buildConnectedWorkspaceAccessTokenStatus(
        {
          integrationId: '33333333-3333-4333-8333-333333333333',
          workspace: {
            uuid: '11111111-1111-4111-8111-111111111111',
            slug: 'acme',
            displayName: 'Acme Workspace',
          },
          credentialVersion: 1,
          repositoryCount: 1,
          validatedAt: '2026-06-24T08:00:00.000Z',
          unexpectedScopes: [],
        },
        true
      )
    ).toEqual({
      status: 'connected',
      recoveryAction: null,
      method: 'workspace_access_token',
      integrationId: '33333333-3333-4333-8333-333333333333',
      integrationStatus: 'active',
      workspace: {
        uuid: '11111111-1111-4111-8111-111111111111',
        slug: 'acme',
        displayName: 'Acme Workspace',
      },
      invalidatedAt: null,
      invalidationReason: null,
      lastValidatedAt: '2026-06-24T08:00:00.000Z',
      unexpectedScopes: [],
      repositoryCache: {
        status: 'uninitialized',
        repositories: [],
        syncedAt: null,
      },
      canManage: true,
    });
  });

  it('warns without rejecting a token that has additional permissions', () => {
    const html = renderToStaticMarkup(
      createElement(BitbucketAdditionalPermissionsWarning, {
        scopes: ['pipeline:write', 'repository:admin'],
      })
    );

    expect(html).toContain('Token has additional permissions');
    expect(html).toContain('pipeline:write');
    expect(html).toContain('repository:admin');
    expect(html).not.toContain('</code>. Cloud Agent');
  });

  it('omits redundant integration controls guidance for OAuth connections', () => {
    expect(getBitbucketIntegrationControlsDescription('oauth', null)).toBeNull();
  });

  it('instructs token replacement only when recovery permits rotation', () => {
    expect(
      getRecoveryGuidance('workspace_access_token', 'replace_token', 'provider_rejected', true)
    ).toContain('Replace the token');
    expect(
      getRecoveryGuidance(
        'workspace_access_token',
        'disconnect_and_connect',
        'provider_rejected',
        true
      )
    ).toContain('Disconnect Bitbucket from Kilo, then connect the workspace again');
    expect(
      getRecoveryGuidance(
        'workspace_access_token',
        'disconnect_and_connect',
        'provider_rejected',
        true
      )
    ).not.toContain('Replace the token');
  });

  it('shows a visible message when Bitbucket OAuth authorization is cancelled', () => {
    expect(getBitbucketConnectionErrorMessage('authorization_cancelled')).toBe(
      'Bitbucket authorization was cancelled. No changes were made. Start OAuth again when you are ready.'
    );

    const html = renderToStaticMarkup(
      createElement(BitbucketConnectionRedirectNotice, { error: 'authorization_cancelled' })
    );

    expect(html).toContain('Bitbucket OAuth was cancelled');
    expect(html).toContain('No changes were made');
  });
});
