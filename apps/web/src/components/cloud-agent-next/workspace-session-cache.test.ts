import { cachedWorkspaceCloudSessionId } from './workspace-session-cache';
import { workspaceSummaryFixture } from './hooks/workspace-summary-test-fixtures';

it('resolves an open or closed chat from hydrated workspace summaries', () => {
  const summary = workspaceSummaryFixture();
  const chat = {
    ...summary.openChats[0],
    cloudAgentSessionId: 'workspace_11111111-1111-4111-8111-111111111111',
  };
  const key = [['cliSessionsV2', 'listWorkspaces'], { input: { organizationId: null } }];
  expect(
    cachedWorkspaceCloudSessionId(chat.sessionId, null, [
      [key, { pages: [{ workspaces: [{ ...summary, openChats: [chat] }] }], pageParams: [null] }],
    ])
  ).toBe(chat.cloudAgentSessionId);
  expect(
    cachedWorkspaceCloudSessionId(chat.sessionId, null, [
      [key, { workspaces: [{ ...summary, openChats: [], closedChats: [chat] }] }],
    ])
  ).toBe(chat.cloudAgentSessionId);
});

it('does not resolve another organization or an unknown chat', () => {
  const summary = workspaceSummaryFixture();
  const key = [
    ['cliSessionsV2', 'workspaceSummaries'],
    { input: { organizationId: 'synthetic-other-scope' } },
  ];
  expect(
    cachedWorkspaceCloudSessionId(summary.openChats[0].sessionId, null, [
      [key, { workspaces: [summary] }],
    ])
  ).toBeNull();
  expect(
    cachedWorkspaceCloudSessionId('ses_missing', 'synthetic-other-scope', [
      [key, { workspaces: [summary] }],
    ])
  ).toBeNull();
});
