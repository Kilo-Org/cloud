import { MOBILE_CHAT_SESSION_SYNC_FLAG } from '@kilocode/app-shared/feature-flags';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { useFeatureFlag } from '@/lib/analytics/posthog';
import { encryptedDatabase } from '@/lib/persist/encrypted-kv';

import { organizationIdOf } from '../layers';
import type { ChatPlace } from '../scope';
import type { ChatSummary } from '../store';
import { syncClientFor } from './sync-client';
import { onChatSettled } from './sync-hooks';
import {
  mergeChatRows,
  selectSyncedListSurface,
  serverListParams,
  type ChatListFilters,
  type MergedChatRow,
  type SyncedListSurface,
} from './sync-list';
import {
  bannerOf,
  onDeletedElsewhere,
  uploadSettledChat,
  watchBanners,
  type SyncBanner,
} from './sync-service';
import {
  readChatSyncSetting,
  writeChatSyncSetting,
  type ChatSyncSetting,
} from './sync-settings';
import { syncedRecordsOfScope } from './sync-store';

/**
 * React's view of chat sync: the gate (flag and per-account setting), the
 * settled-exchange uploader, the merged server list, and the banner a chat
 * screen reads. Screens compose these; nothing here draws.
 */

export type ChatSyncGate = {
  readonly flagOn: boolean;
  readonly setting: ChatSyncSetting;
  /** Both halves on: sync runs. */
  readonly enabled: boolean;
  readonly decide: (choice: 'on' | 'off') => Promise<void>;
};

export function useChatSyncGate(place: ChatPlace | null): ChatSyncGate {
  const flagOn = useFeatureFlag(MOBILE_CHAT_SESSION_SYNC_FLAG, false);
  const client = useQueryClient();
  const scope = place?.chatScope ?? '';
  const query = useQuery({
    queryKey: ['chat-sync-setting', scope],
    enabled: place !== null,
    networkMode: 'always',
    queryFn: async (): Promise<ChatSyncSetting> =>
      place === null ? { kind: 'undecided' } : readChatSyncSetting(place.chatScope),
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
  const setting = query.data ?? { kind: 'undecided' as const };
  return { flagOn, setting, enabled: flagOn && setting.kind === 'on', decide };
}

/** Registers the settled-exchange uploader while sync is enabled. */
export function useChatSyncUploader(place: ChatPlace | null, enabled: boolean): void {
  useEffect(() => {
    if (place === null || !enabled) {
      return;
    }
    return onChatSettled((sessionId, turns) => {
      void uploadSettledChat(place, sessionId, turns);
    });
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
