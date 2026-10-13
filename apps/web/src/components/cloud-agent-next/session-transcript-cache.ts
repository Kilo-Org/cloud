import type { QueryClient } from '@tanstack/react-query';
import type { KiloSessionId, SessionSnapshotPage } from '@kilocode/cloud-agent-sdk';

export function createWebSessionTranscriptCache(queryClient: QueryClient, scope: string) {
  const queryKey = ['cloud-agent-transcript', scope];
  queryClient.setQueryDefaults(['cloud-agent-transcript'], {
    gcTime: 5 * 60_000,
    structuralSharing: false,
  });

  return {
    read: async (sessionId: KiloSessionId): Promise<SessionSnapshotPage | null> => {
      await Promise.resolve();
      return queryClient.getQueryData<SessionSnapshotPage>([...queryKey, sessionId]) ?? null;
    },
    write: (page: SessionSnapshotPage): void => {
      const messages = page.messages.slice(-50);
      const snapshot = { ...page, messages, nextCursor: null, omittedItemCount: 0 };
      const updatedAt = Date.now();
      queueMicrotask(() => {
        try {
          if (JSON.stringify(snapshot).length > 1_000_000) {
            queryClient.removeQueries({ queryKey: [...queryKey, page.info.id], exact: true });
            return;
          }
          queryClient.setQueryData([...queryKey, page.info.id], snapshot, { updatedAt });
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
  };
}
