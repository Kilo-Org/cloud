import { cachedWorkspaceCloudSessionId } from './workspace-session-cache';
import { workspaceSummaryFixture } from './hooks/workspace-summary-test-fixtures';

it('resolves only the navigation target paired with the cloud session ID', () => {
  const summary = workspaceSummaryFixture({
    latestSessionId: 'ses_closed',
    cloudAgentSessionId: 'workspace_11111111-1111-4111-8111-111111111111',
  });
  const key = [['cliSessionsV2', 'listWorkspaces'], { input: { organizationId: null } }];
  expect(
    cachedWorkspaceCloudSessionId('ses_root', null, [
      [key, { pages: [{ workspaces: [summary] }], pageParams: [null] }],
    ])
  ).toBe(summary.cloudAgentSessionId);
  expect(
    cachedWorkspaceCloudSessionId('ses_closed', null, [[key, { workspaces: [summary] }]])
  ).toBeNull();
});

it('does not resolve another organization or an unknown chat', () => {
  const summary = workspaceSummaryFixture();
  const key = [
    ['cliSessionsV2', 'workspaceSummaries'],
    { input: { organizationId: 'synthetic-other-scope' } },
  ];
  expect(
    cachedWorkspaceCloudSessionId(summary.rootSessionId, null, [[key, { workspaces: [summary] }]])
  ).toBeNull();
  expect(
    cachedWorkspaceCloudSessionId('ses_missing', 'synthetic-other-scope', [
      [key, { workspaces: [summary] }],
    ])
  ).toBeNull();
});
