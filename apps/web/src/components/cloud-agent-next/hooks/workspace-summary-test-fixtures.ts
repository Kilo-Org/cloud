import type { WorkspaceSummary } from './useWorkspaceSummaries';

export const WORKSPACE_FIXTURE_TIME = '2026-11-10T12:00:00.000Z';
export const WORKSPACE_FIXTURE_ID = 'worktree_11111111-1111-4111-8111-111111111111';

export function workspaceSummaryFixture(
  overrides: Partial<WorkspaceSummary> = {}
): WorkspaceSummary {
  const worktreeId = overrides.worktreeId ?? WORKSPACE_FIXTURE_ID;
  return {
    worktreeId,
    name: 'Workspace',
    defaultTitle: null,
    branch: 'feature',
    baseBranch: 'main',
    baseSha: 'synthetic-base-sha',
    parentWorktreeId: null,
    createdAt: WORKSPACE_FIXTURE_TIME,
    lastActivityAt: WORKSPACE_FIXTURE_TIME,
    folderId: null,
    sidebarPosition: null,
    rootSessionId: 'ses_root',
    latestSessionId: 'ses_root',
    latestOpenSessionId: 'ses_root',
    cloudAgentSessionId: null,
    gitUrl: 'https://github.com/example/repository.git',
    pr: null,
    status: {
      sessionId: 'ses_root',
      kind: 'idle',
      sessionStatus: null,
      statusUpdatedAt: WORKSPACE_FIXTURE_TIME,
      latestRunFailureKind: null,
      latestRunTerminalAt: null,
    },
    sessionStatus: null,
    destination: { kind: 'ungrouped' },
    stackRootId: worktreeId,
    stackDepth: 0,
    chatCount: 1,
    hasOpenRun: false,
    openChats: [
      {
        sessionId: 'ses_root',
        title: 'Chat',
        createdAt: WORKSPACE_FIXTURE_TIME,
        updatedAt: WORKSPACE_FIXTURE_TIME,
        lastActivityAt: null,
        cloudAgentSessionId: null,
        sessionStatus: null,
        sessionStatusUpdatedAt: null,
      },
    ],
    closedChats: [],
    ...overrides,
  };
}
