import { describe, expect, it } from 'vitest';

import {
  buildIntegrationRows,
  type IntegrationGitHubConnection,
  type IntegrationSetupStatus,
} from './integration-rows';

function setupStatus(
  platform: IntegrationSetupStatus['platform'],
  installed: boolean,
  installation: IntegrationSetupStatus['installation'] = null
): IntegrationSetupStatus {
  return { platform, installed, installation };
}

function githubConnection(
  overrides: Partial<IntegrationGitHubConnection> = {}
): IntegrationGitHubConnection {
  return {
    id: 'gh-1',
    platform: 'github',
    integration_status: 'active',
    platform_account_id: '1',
    platform_account_login: 'acme',
    repository_access: 'all',
    repositories: [],
    repositories_synced_at: null,
    suspended_at: null,
    installed_at: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    canUninstallNatively: true,
    ...overrides,
  };
}

const NO_CONNECTIONS: IntegrationGitHubConnection[] = [];

describe('buildIntegrationRows', () => {
  it('reads each provider status and the account its own field names', () => {
    const rows = buildIntegrationRows({
      scope: 'personal',
      statuses: [
        setupStatus('slack', true, { teamName: 'Acme Slack' }),
        setupStatus('linear', true, { workspaceName: 'Acme Linear' }),
        setupStatus('github', false),
      ],
      githubConnections: NO_CONNECTIONS,
    });

    expect(rows.map(row => row.provider)).toEqual(['github', 'slack', 'gitlab', 'linear']);
    expect(rows.find(row => row.provider === 'slack')).toMatchObject({
      installed: true,
      accountLabel: 'Acme Slack',
    });
    expect(rows.find(row => row.provider === 'linear')).toMatchObject({
      installed: true,
      accountLabel: 'Acme Linear',
    });
    expect(rows.find(row => row.provider === 'github')).toMatchObject({
      installed: false,
      accountLabel: null,
    });
    expect(rows.find(row => row.provider === 'gitlab')).toMatchObject({ installed: false });
  });

  it('leaves an installed provider without a named account but still connected', () => {
    const rows = buildIntegrationRows({
      scope: 'personal',
      statuses: [setupStatus('gitlab', true, { accountLogin: null })],
      githubConnections: NO_CONNECTIONS,
    });
    expect(rows.find(row => row.provider === 'gitlab')).toMatchObject({
      installed: true,
      accountLabel: null,
    });
  });

  it('targets the single active GitHub connection an organization install removes', () => {
    const rows = buildIntegrationRows({
      scope: 'organization',
      statuses: [setupStatus('github', true, { accountLogin: 'acme' })],
      githubConnections: [
        githubConnection({ id: 'gh-active' }),
        githubConnection({ id: 'gh-suspended', suspended_at: '2026-01-02T00:00:00.000Z' }),
      ],
    });
    const github = rows.find(row => row.provider === 'github');
    expect(github).toMatchObject({ githubIntegrationId: 'gh-active', webManaged: false });
  });

  it('sends a GitHub connection the server will not uninstall to the web page', () => {
    const rows = buildIntegrationRows({
      scope: 'organization',
      statuses: [setupStatus('github', true, { accountLogin: 'acme' })],
      githubConnections: [githubConnection({ id: 'gh-shared', canUninstallNatively: false })],
    });
    expect(rows.find(row => row.provider === 'github')).toMatchObject({
      installed: true,
      githubIntegrationId: null,
      webManaged: true,
    });
  });

  it('sends an ambiguous GitHub organization to the web page', () => {
    const rows = buildIntegrationRows({
      scope: 'organization',
      statuses: [setupStatus('github', true, { accountLogin: 'acme' })],
      githubConnections: [githubConnection({ id: 'gh-1' }), githubConnection({ id: 'gh-2' })],
    });
    expect(rows.find(row => row.provider === 'github')).toMatchObject({
      githubIntegrationId: null,
      webManaged: true,
    });
  });

  it('sends a GitHub row with no readable connection to the web page', () => {
    const rows = buildIntegrationRows({
      scope: 'organization',
      statuses: [setupStatus('github', true, { accountLogin: 'acme' })],
      githubConnections: [githubConnection({ integration_status: 'suspended' })],
    });
    expect(rows.find(row => row.provider === 'github')).toMatchObject({
      installed: true,
      githubIntegrationId: null,
      webManaged: true,
    });
  });

  it('keeps every other provider native, and Bitbucket web-managed', () => {
    const rows = buildIntegrationRows({
      scope: 'organization',
      statuses: [
        setupStatus('slack', true, { teamName: 'Acme' }),
        setupStatus('bitbucket', true, { accountLogin: 'acme-workspace' }),
      ],
      githubConnections: NO_CONNECTIONS,
    });
    expect(rows.find(row => row.provider === 'slack')).toMatchObject({ webManaged: false });
    expect(rows.find(row => row.provider === 'bitbucket')).toMatchObject({
      installed: true,
      accountLabel: 'acme-workspace',
      webManaged: true,
    });
  });

  it('withholds a connected GitHub row until the connections read settles', () => {
    const pending = buildIntegrationRows({
      scope: 'organization',
      statuses: [setupStatus('github', true, { accountLogin: 'acme' })],
      githubConnections: NO_CONNECTIONS,
      githubConnectionsPending: true,
    });
    expect(pending.find(row => row.provider === 'github')).toMatchObject({
      installed: true,
      githubIntegrationId: null,
      webManaged: false,
      actionPending: true,
    });

    const settled = buildIntegrationRows({
      scope: 'organization',
      statuses: [setupStatus('github', true, { accountLogin: 'acme' })],
      githubConnections: [githubConnection({ id: 'gh-1' })],
    });
    expect(settled.find(row => row.provider === 'github')).toMatchObject({
      githubIntegrationId: 'gh-1',
      actionPending: false,
    });
  });

  it('connects a GitHub row before the connections read settles', () => {
    const rows = buildIntegrationRows({
      scope: 'personal',
      statuses: [setupStatus('github', false)],
      githubConnections: NO_CONNECTIONS,
      githubConnectionsPending: true,
    });
    expect(rows.find(row => row.provider === 'github')).toMatchObject({
      installed: false,
      actionPending: false,
    });
  });

  it('omits the org-only provider from a personal scope', () => {
    const rows = buildIntegrationRows({
      scope: 'personal',
      statuses: [setupStatus('bitbucket', true, { accountLogin: 'acme-workspace' })],
      githubConnections: NO_CONNECTIONS,
    });
    expect(rows.map(row => row.provider)).not.toContain('bitbucket');
  });
});
