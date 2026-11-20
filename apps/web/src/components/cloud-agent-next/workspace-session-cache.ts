import type { InfiniteData } from '@tanstack/react-query';
import type { WorkspaceSummary } from './hooks/useWorkspaceSummaries';
import { sidebarQueryInput } from './hooks/sidebar-query-scope';

export type WorkspaceSessionCache =
  | { workspaces: WorkspaceSummary[] }
  | InfiniteData<{ workspaces: WorkspaceSummary[] }>;

export function cachedWorkspaceCloudSessionId(
  sessionId: string,
  organizationId: string | null,
  caches: readonly (readonly [readonly unknown[], WorkspaceSessionCache | undefined])[]
): string | null {
  for (const [key, data] of caches) {
    if (!data || sidebarQueryInput(key)?.organizationId !== organizationId) continue;
    const workspaces =
      'pages' in data ? data.pages.flatMap(page => page.workspaces) : data.workspaces;
    for (const workspace of workspaces) {
      const chat = [...workspace.openChats, ...workspace.closedChats].find(
        chat => chat.sessionId === sessionId
      );
      if (chat?.cloudAgentSessionId) return chat.cloudAgentSessionId;
    }
  }
  return null;
}
