import { startOfDay, subDays } from 'date-fns';
import type { TRPCQueryKey } from '@trpc/tanstack-react-query';
import {
  cloudAgentWorktreeIdSchema,
  type CloudAgentWorktreeId,
} from '@kilocode/session-ingest-contracts';

/**
 * The sidebar's query inputs, shared by the client hooks and the server prefetch,
 * so a prefetched query has the exact key the client reads first.
 */

export const SIDEBAR_LIST_LIMIT = 200;
export const DEFAULT_SIDEBAR_PLATFORM_FILTER = ['cloud-agent'];
const WORKTREE_DETAILS_BATCH_SIZE = 200;

/** The oldest activity the sidebar lists. */
export function sidebarUpdatedSince(now: Date): string {
  return startOfDay(subDays(now, 5)).toISOString();
}

/** The platforms the server filters by for the sidebar's platform choice. */
export function createdOnPlatformForFilter(
  platformFilter: readonly string[]
): string[] | undefined {
  if (platformFilter.length === 0) return undefined;
  return platformFilter.flatMap(platform => {
    switch (platform) {
      // 'cloud-agent-web' is a variant of the cloud agent
      case 'cloud-agent':
        return ['cloud-agent', 'cloud-agent-web'];
      // Extension sessions are created from VS Code or agent-manager
      case 'extension':
        return ['vscode', 'agent-manager'];
      default:
        return [platform];
    }
  });
}

type SidebarFilters = {
  organizationId: string | null | undefined;
  createdOnPlatform: string | string[] | undefined;
  gitUrl: string | string[] | undefined;
};

export function sidebarListInput({
  updatedSince,
  organizationId,
  createdOnPlatform,
  gitUrl,
}: SidebarFilters & { updatedSince: string }) {
  return {
    updatedSince,
    limit: SIDEBAR_LIST_LIMIT,
    orderBy: 'updated_at' as const,
    organizationId,
    createdOnPlatform,
    gitUrl,
    fetchReviewDecision: true,
  };
}

/** The latest session of a worktree in a folder, which may be older than the list. */
export function sidebarFolderListInput(
  worktreeId: CloudAgentWorktreeId,
  { organizationId, createdOnPlatform, gitUrl }: SidebarFilters
) {
  return {
    worktreeId,
    limit: 1,
    orderBy: 'updated_at' as const,
    organizationId,
    createdOnPlatform,
    gitUrl,
    fetchReviewDecision: true,
  };
}

/** The folders list is cached per user, so another user's folders never show. */
export function workspaceFoldersQueryKey(baseKey: TRPCQueryKey, userId: string): TRPCQueryKey {
  const options = { ...baseKey[1], userId };
  return [baseKey[0], options];
}

/** Worktree ids in sorted batches, one details query per batch. */
export function worktreeDetailsBatches(
  worktreeIds: Iterable<string | null | undefined>
): CloudAgentWorktreeId[][] {
  const ids = [
    ...new Set(
      [...worktreeIds].flatMap(id => {
        const parsed = cloudAgentWorktreeIdSchema.safeParse(id);
        return parsed.success ? [parsed.data] : [];
      })
    ),
  ].sort();
  const batches: CloudAgentWorktreeId[][] = [];
  for (let index = 0; index < ids.length; index += WORKTREE_DETAILS_BATCH_SIZE) {
    batches.push(ids.slice(index, index + WORKTREE_DETAILS_BATCH_SIZE));
  }
  return batches;
}
