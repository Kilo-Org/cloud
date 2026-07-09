import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildConnectedWorkspaceAccessTokenStatus } from '@/components/integrations/BitbucketConnectSetup';
import {
  BitbucketAdditionalPermissionsWarning,
  getRecoveryGuidance,
} from '@/components/integrations/BitbucketConnectedManagement';
import {
  BitbucketConnectionRedirectNotice,
  getBitbucketConnectionErrorMessage,
} from '@/components/integrations/BitbucketIntegrationDetails';
import { getBitbucketIntegrationControlsDescription } from '@/components/integrations/BitbucketIntegrationControls';

describe('Bitbucket integration UI state', () => {
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
