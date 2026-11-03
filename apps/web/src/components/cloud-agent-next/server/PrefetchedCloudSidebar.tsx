import 'server-only';
import type { ReactNode } from 'react';
import * as Sentry from '@sentry/nextjs';
import { dehydrate, HydrationBoundary, QueryClient } from '@tanstack/react-query';
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query';
import pLimit from 'p-limit';
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';
import { createTRPCContext } from '@kilocode/web-shared/lib/trpc/init';
import { rootRouter } from '@/routers/root-router';
import {
  createdOnPlatformForFilter,
  sidebarFolderListInput,
  sidebarListInput,
  workspaceFoldersQueryKey,
  worktreeDetailsBatches,
} from '../hooks/sidebar-queries';
import { DEFAULT_SIDEBAR_PREFERENCES } from '../sidebar-preferences';
import type { SidebarPreferences } from '../sidebar-preferences';

/** A slow backend must not hold the page; the client loads what the server did not. */
const SIDEBAR_PREFETCH_TIMEOUT_MS = 1500;

type SidebarScope = {
  userId: string;
  organizationId: string | null;
  updatedSince: string;
  preferences: SidebarPreferences | null;
};

/**
 * Prefetches what the Cloud Agent sidebar reads first, under the client's own
 * keys, so it renders its rows during SSR instead of a loading skeleton.
 */
export async function PrefetchedCloudSidebar({
  children,
  ...scope
}: SidebarScope & { children: ReactNode }) {
  const queryClient = new QueryClient();
  const deadlineAt = Date.now() + SIDEBAR_PREFETCH_TIMEOUT_MS;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      prefetchSidebar(queryClient, scope, deadlineAt),
      new Promise(resolve => {
        timeout = setTimeout(resolve, SIDEBAR_PREFETCH_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    // The client fetches whatever is missing; still report real server failures.
    Sentry.captureException(error);
  } finally {
    clearTimeout(timeout);
  }
  return <HydrationBoundary state={dehydrate(queryClient)}>{children}</HydrationBoundary>;
}

async function prefetchSidebar(
  queryClient: QueryClient,
  { userId, organizationId, updatedSince, preferences }: SidebarScope,
  deadlineAt: number
): Promise<void> {
  const { platformFilter, projectFilter } = preferences ?? DEFAULT_SIDEBAR_PREFERENCES;
  const ctx = await createTRPCContext();
  if (Date.now() >= deadlineAt) return;
  const trpc = createTRPCOptionsProxy({ router: rootRouter, ctx, queryClient });
  const filters = {
    organizationId,
    createdOnPlatform: createdOnPlatformForFilter(platformFilter),
    gitUrl: projectFilter.length > 0 ? projectFilter : undefined,
  };
  const foldersOptions = trpc.workspaceFolders.list.queryOptions({ organizationId });
  const [list, folders] = await Promise.all([
    queryClient.query(
      trpc.cliSessionsV2.list.queryOptions(sidebarListInput({ updatedSince, ...filters }))
    ),
    queryClient.query({
      ...foldersOptions,
      queryKey: workspaceFoldersQueryKey(foldersOptions.queryKey, userId),
    }),
  ]);
  const folderWorktreeIds = new Set(folders.folders.flatMap(folder => folder.worktreeIds));
  const limit = pLimit(4);
  const folderLists = await Promise.all(
    [...folderWorktreeIds].flatMap(id => {
      const parsed = cloudAgentWorktreeIdSchema.safeParse(id);
      if (!parsed.success) return [];
      return [
        limit(() => {
          if (Date.now() >= deadlineAt) return undefined;
          return queryClient.query(
            trpc.cliSessionsV2.list.queryOptions(sidebarFolderListInput(parsed.data, filters))
          );
        }),
      ];
    })
  );
  const sessions = [list, ...folderLists].flatMap(result => result?.cliSessions ?? []);
  await Promise.all(
    worktreeDetailsBatches(sessions.map(session => session.cloud_agent_worktree_id)).map(
      worktreeIds =>
        limit(() => {
          if (Date.now() >= deadlineAt) return;
          return queryClient
            .query(trpc.cliSessionsV2.worktreeDetails.queryOptions({ worktreeIds, organizationId }))
            .catch(() => undefined);
        })
    )
  );
}
