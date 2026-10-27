import type { QueryClient } from '@tanstack/react-query';
import type { CachedSessionSnapshotPage, KiloSessionId } from '@kilocode/cloud-agent-sdk';

const TRANSCRIPT_CACHE_ROOT = 'cloud-agent-transcript';
const CACHED_MESSAGE_LIMIT = 50;

/** One cache per account context, so personal and organization chats stay apart. */
export function transcriptCacheScope(organizationId: string | null): string {
  return organizationId ?? 'personal';
}

export function transcriptCacheKey(scope: string, sessionId: string) {
  return [TRANSCRIPT_CACHE_ROOT, scope, sessionId] as const;
}

/** The recent tail of a page; the live page restores pagination when it lands. */
export function toCachedTranscriptPage(page: CachedSessionSnapshotPage): CachedSessionSnapshotPage {
  return {
    ...page,
    messages: page.messages.slice(-CACHED_MESSAGE_LIMIT),
    nextCursor: null,
    omittedItemCount: 0,
  };
}

export function createWebSessionTranscriptCache(queryClient: QueryClient, scope: string) {
  const queryKey = [TRANSCRIPT_CACHE_ROOT, scope];
  queryClient.setQueryDefaults([TRANSCRIPT_CACHE_ROOT], {
    gcTime: 5 * 60_000,
    structuralSharing: false,
  });

  return {
    // Synchronous, so a reopened session paints from its cached page in the first frame.
    read: (sessionId: KiloSessionId): CachedSessionSnapshotPage | null =>
      queryClient.getQueryData<CachedSessionSnapshotPage>(transcriptCacheKey(scope, sessionId)) ??
      null,
    write: (page: CachedSessionSnapshotPage): void => {
      const snapshot = toCachedTranscriptPage(page);
      const updatedAt = Date.now();
      queueMicrotask(() => {
        try {
          if (JSON.stringify(snapshot).length > 1_000_000) {
            queryClient.removeQueries({ queryKey: [...queryKey, page.info.id], exact: true });
            return;
          }
          queryClient.setQueryData(transcriptCacheKey(scope, page.info.id), snapshot, {
            updatedAt,
          });
          const cached = queryClient
            .getQueryCache()
            .findAll({ queryKey })
            .filter(query => query.queryKey.at(-1) !== page.info.id)
            .reverse()
            .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt);
          for (const query of cached.slice(4)) {
            queryClient.removeQueries({ queryKey: query.queryKey, exact: true });
          }
        } catch {
          // A cache failure must not prevent navigation.
        }
      });
    },
    // Drop this provider's page for a session the server answered as not
    // available.
    invalidate: (sessionId: KiloSessionId): void => {
      queryClient.removeQueries({ queryKey: transcriptCacheKey(scope, sessionId), exact: true });
    },
  };
}
