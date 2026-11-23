import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { encryptedDatabase } from '@/lib/persist/encrypted-kv';

import { type ChatSyncGate, selectChatSyncSettingState } from './sync-gate';

import { organizationIdOf } from '../layers';
import  { type ChatPlace } from '../scope';
import  { type ChatSummary } from '../store';
import { syncClientFor } from './sync-client';
import {
  type ChatListFilters,
  mergeChatRows,
  type MergedChatRow,
  selectSyncedListSurface,
  serverListParams,
  type SyncedListSurface,
} from './sync-list';
import {
  bannerOf,
  onDeletedElsewhere,
  registerSyncUploader,
  type SyncBanner,
  watchBanners,
} from './sync-service';
import {
  type ChatSyncSetting,
  markSyncNoticeSeen,
  readChatSyncSetting,
  readSyncNoticeSeen,
  writeChatSyncSetting,
} from './sync-settings';
export { selectChatSyncSettingState, type ChatSyncSettingState } from './sync-gate';
import { syncedRecordsOfScope } from './sync-store';

/**
 * React's view of chat sync: the per-account setting, the settled-exchange
 * uploader, the merged server list, and the banner a chat screen reads.
 * Screens compose these; nothing here draws.
 */

export function useChatSyncGate(place: ChatPlace | null): ChatSyncGate {
  const client = useQueryClient();
  const scope = place?.chatScope ?? '';
  const query = useQuery({
    queryKey: ['chat-sync-setting', scope],
    enabled: place !== null,
    networkMode: 'always',
    queryFn: async (): Promise<ChatSyncSetting> =>
      place === null ? 'on' : readChatSyncSetting(place.chatScope),
  });
  const decide = useCallback(
    async (choice: 'on' | 'off') => {
      if (place === null) {
        return;
      }
      await writeChatSyncSetting(place.chatScope, choice);
      await client.invalidateQueries({ queryKey: ['chat-sync-setting', scope] });
    },
    [client, place, scope]
  );
  const state = selectChatSyncSettingState({
    hasPlace: place !== null,
    isPending: query.isPending,
    isPaused: query.fetchStatus === 'paused',
    isError: query.isError,
    setting: query.data,
    retry: () => {
      void query.refetch();
    },
  });
  return { state, enabled: state.kind === 'on', decide };
}

/** Registers the settled-exchange uploader while sync is enabled. */
export function useChatSyncUploader(place: ChatPlace | null, enabled: boolean): void {
  useEffect(() => {
    if (place === null || !enabled) {
      return;
    }
    return registerSyncUploader(place);
  }, [place, enabled]);
}

/** Surfaces a deleted-elsewhere toast through `announce`, set by the list screen. */
export function useDeletedElsewhere(announce: (sessionId: string) => void): void {
  useEffect(() => onDeletedElsewhere(announce), [announce]);
}

export function useSyncBanner(sessionId: string): SyncBanner {
  return useSyncExternalStore(
    watchBanners,
    useCallback(() => bannerOf(sessionId), [sessionId]),
    useCallback(() => bannerOf(sessionId), [sessionId])
  );
}

export type MergedChatList = {
  readonly surface: SyncedListSurface;
  readonly rows: readonly MergedChatRow[];
  readonly hasNextPage: boolean;
  readonly fetchNextPage: () => void;
  readonly refetch: () => void;
  /** A later page failed while earlier rows stand: retryable, not a failed list. */
  readonly nextPageFailed: boolean;
};

/**
 * Server sessions as an infinite query, merged with the local list. When
 * sync is off the query never runs and the rows are the local ones, so the
 * list screen reads one shape either way.
 */
export function useMergedChatList(input: {
  readonly place: ChatPlace | null;
  readonly enabled: boolean;
  readonly chats: readonly ChatSummary[];
  readonly filters: ChatListFilters;
}): MergedChatList {
  const { place, enabled, chats, filters } = input;
  const query = useInfiniteQuery({
    queryKey: ['chat-sync-sessions', place?.chatScope ?? '', filters],
    enabled: place !== null && enabled,
    staleTime: 30_000,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const client = syncClientFor(
        place === null ? undefined : organizationIdOf(place.org)
      );
      return client.listSessions({
        ...serverListParams(filters),
        ...(pageParam === null ? {} : { cursor: pageParam }),
      });
    },
    getNextPageParam: last => last.cursor,
  });
  const recordsQuery = useQuery({
    queryKey: ['chat-sync-records', place?.chatScope ?? '', chats.length],
    enabled: place !== null && enabled,
    networkMode: 'always',
    queryFn: async () =>
      place === null
        ? []
        : syncedRecordsOfScope(await encryptedDatabase(), place.chatScope),
  });
  const listed = query.data?.pages.flatMap(page => page.items) ?? [];
  const rows = mergeChatRows({
    chats,
    records: recordsQuery.data ?? [],
    listed,
    filters,
  });
  const surface = selectSyncedListSurface({
    enabled,
    isPending: query.isPending && query.fetchStatus !== 'paused',
    isError: query.isError && !query.isFetchNextPageError,
    isPaused: query.fetchStatus === 'paused' && query.data === undefined,
    rows,
  });
  return {
    surface,
    rows,
    hasNextPage: query.hasNextPage,
    fetchNextPage: () => {
      void query.fetchNextPage();
    },
    refetch: () => {
      void query.refetch();
    },
    nextPageFailed: query.isFetchNextPageError,
  };
}

/** The one-time upgrade notice: shown until this account dismisses it. */
export function useChatSyncNotice(place: ChatPlace | null): {
  readonly visible: boolean;
  readonly dismiss: () => void;
} {
  const client = useQueryClient();
  const scope = place?.chatScope ?? '';
  const query = useQuery({
    queryKey: ['chat-sync-notice', scope],
    enabled: place !== null,
    networkMode: 'always',
    queryFn: async () => (place === null ? true : readSyncNoticeSeen(place.chatScope)),
  });
  const dismiss = useCallback(() => {
    if (place === null) {
      return;
    }
    void (async () => {
      await markSyncNoticeSeen(place.chatScope);
      await client.invalidateQueries({ queryKey: ['chat-sync-notice', scope] });
    })();
  }, [client, place, scope]);
  return { visible: place !== null && query.data === false, dismiss };
}
