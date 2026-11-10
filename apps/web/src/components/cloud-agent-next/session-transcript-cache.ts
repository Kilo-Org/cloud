import type { QueryClient } from '@tanstack/react-query';
import type { CachedSessionSnapshotPage, KiloSessionId } from '@kilocode/cloud-agent-sdk';

const TRANSCRIPT_CACHE_ROOT = 'cloud-agent-transcript';
const CACHED_MESSAGE_LIMIT = 50;

/** The signed-in user and the account context the chat is read in. */
export type TranscriptCacheScope = { userId: string; organizationId: string | null };

/** One cache per user and account context, so another user's chats never show. */
export function transcriptCacheScope(
  userId: string,
  organizationId: string | null
): TranscriptCacheScope {
  return { userId, organizationId };
}

/** The cached pages of one user and account context, oldest evicted first. */
function transcriptScopePrefix(scope: TranscriptCacheScope) {
  return [TRANSCRIPT_CACHE_ROOT, scope.userId, scope.organizationId ?? 'personal'] as const;
}

export function transcriptCacheKey(scope: TranscriptCacheScope, sessionId: string) {
  return [...transcriptScopePrefix(scope), sessionId] as const;
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

/**
 * `read` resolves the scope each time it is called; `write` resolves it once,
 * when the write is called, before the page is queued.
 */
export function createWebSessionTranscriptCache(
  queryClient: QueryClient,
  currentScope: () => TranscriptCacheScope
) {
  queryClient.setQueryDefaults([TRANSCRIPT_CACHE_ROOT], {
    gcTime: 5 * 60_000,
    structuralSharing: false,
  });

  return {
    // Synchronous, so a reopened session paints from its cached page in the first frame.
    read: (sessionId: KiloSessionId): CachedSessionSnapshotPage | null =>
      queryClient.getQueryData<CachedSessionSnapshotPage>(
        transcriptCacheKey(currentScope(), sessionId)
      ) ?? null,
    write: (page: CachedSessionSnapshotPage): void => {
      const snapshot = toCachedTranscriptPage(page);
      const scope = currentScope();
      const updatedAt = Date.now();
      queueMicrotask(() => {
        try {
          const queryKey = transcriptScopePrefix(scope);
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
      queryClient.removeQueries({
        queryKey: transcriptCacheKey(currentScope(), sessionId),
        exact: true,
      });
    },
  };
}
