import type { StoredSession } from '../types';
import { extractRepoFromGitUrl } from '../utils/git-utils';
import { getChatDisplayTitle } from '../utils/session-title';
import type { WorkspaceSummary } from './useWorkspaceSummaries';
import type { SidebarWorktreeDetails, SidebarWorktreeGroup } from './sidebar-session-model';

import type { WorkspaceChatSummary } from '@/lib/cloud-agent/workspace-read-model';

export function workspaceChatToStoredSession(
  workspace: WorkspaceSummary,
  chat: WorkspaceChatSummary
): StoredSession {
  return {
    sessionId: chat.sessionId,
    repository: extractRepoFromGitUrl(workspace.gitUrl) ?? '',
    branch: workspace.branch,
    worktreeId: workspace.worktreeId,
    prompt: getChatDisplayTitle(chat.title),
    mode: 'code',
    model: '',
    status: chat.cloudAgentSessionId ? 'active' : 'completed',
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    lastActivityAt: chat.lastActivityAt,
    messages: [],
    cloudAgentSessionId: chat.cloudAgentSessionId,
    createdOnPlatform: null,
    sessionStatus: chat.sessionStatus,
    sessionStatusUpdatedAt: chat.sessionStatusUpdatedAt,
    associatedPr: workspace.pr,
  };
}

export function workspaceHasNavigationSession(row: WorkspaceSummary, sessionId: string) {
  return (
    row.latestSessionId === sessionId ||
    row.latestOpenSessionId === sessionId ||
    row.rootSessionId === sessionId ||
    row.status.sessionId === sessionId
  );
}

export function workspaceRowRepresentativeSession(row: WorkspaceSummary): StoredSession {
  const sessionId = row.latestOpenSessionId ?? row.latestSessionId ?? row.rootSessionId ?? '';
  return {
    sessionId,
    repository: extractRepoFromGitUrl(row.gitUrl) ?? '',
    branch: row.branch,
    worktreeId: row.worktreeId,
    prompt: getChatDisplayTitle(row.defaultTitle),
    mode: 'code',
    model: '',
    status: row.cloudAgentSessionId ? 'active' : 'completed',
    messages: [],
    cloudAgentSessionId: row.cloudAgentSessionId,
    associatedPr: row.pr,
    createdAt: row.createdAt,
    updatedAt: row.lastActivityAt,
    lastActivityAt: row.lastActivityAt,
    sessionStatus: row.sessionStatus,
    sessionStatusUpdatedAt: row.status.statusUpdatedAt,
  };
}

export function workspaceRowToSidebarDetails(row: WorkspaceSummary): SidebarWorktreeDetails {
  return {
    name: row.name,
    defaultTitle: row.defaultTitle,
    prSession: workspaceRowRepresentativeSession(row),
    sessions: [],
    branch: row.branch,
    parentWorktreeId: row.parentWorktreeId,
    baseBranch: row.baseBranch,
    baseSha: row.baseSha,
    folderId: row.folderId,
    sidebarPosition: row.sidebarPosition,
    createdAt: row.createdAt,
    gitUrl: row.gitUrl,
  };
}

export function groupSidebarWorkspaces(
  pendingSessions: readonly StoredSession[],
  details: Record<string, SidebarWorktreeDetails> = {},
  rows: readonly WorkspaceSummary[] = []
): SidebarWorktreeGroup[] {
  const groups = new Map<string, SidebarWorktreeGroup>();
  for (const row of rows) {
    groups.set(row.worktreeId, {
      type: 'worktree',
      worktreeId: row.worktreeId,
      sessions: [],
      latestSession: workspaceRowRepresentativeSession(row),
      details: details[row.worktreeId] ?? workspaceRowToSidebarDetails(row),
      summary: row,
      stackDepth: row.stackDepth,
    });
  }
  for (const session of pendingSessions) {
    if (!session.localSync || !session.worktreeId) continue;
    const group = groups.get(session.worktreeId);
    if (group) {
      if (!group.sessions.some(chat => chat.sessionId === session.sessionId))
        group.sessions.push(session);
    } else {
      groups.set(session.worktreeId, {
        type: 'worktree',
        worktreeId: session.worktreeId,
        sessions: [session],
        latestSession: session,
        details: details[session.worktreeId],
      });
    }
  }
  const roots: SidebarWorktreeGroup[] = [];
  for (const group of groups.values()) {
    const rootId = group.summary?.stackRootId;
    const root = rootId && rootId !== group.worktreeId ? groups.get(rootId) : undefined;
    if (root) (root.stackLayers ??= []).push(group);
    else roots.push(group);
  }
  for (const root of roots)
    root.stackLayers?.sort((a, b) => (a.stackDepth ?? 0) - (b.stackDepth ?? 0));
  return roots;
}
