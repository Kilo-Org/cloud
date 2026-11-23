import { FlashList } from '@shopify/flash-list';
import { type Href, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { toast } from 'sonner-native';
import { useTranslation } from 'react-i18next';

import { StateSurfaceInsets } from '@/components/centered-state-surface';
import { CONTEXT_CONTROL_INLINE_MIN_DP, ContextControl } from '@/components/context-control';
import { EmptyState, StateAction } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Fab, FAB_GUTTER, FAB_MARGIN, FAB_SIZE } from '@/components/ui/fab';
import { MessageCircle, MessageCirclePlus } from '@/components/ui/icons';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { useAuth } from '@/lib/auth/auth-context';
import { autoModelLabel } from '@/lib/auto-model-name';
import { defaultChatModel } from '@/lib/chat/backend-model-options';
import { rememberModelFacts } from '@/lib/chat/layers';
import { type ChatSummary } from '@/lib/chat/store';
import { newChat, useChatList, useChatPlace } from '@/lib/chat/use-chat';
import { useChatBackends } from '@/lib/chat/backend-store';
import { useLocalModels } from '@/lib/chat/local-models';
import { useChatModelOptions } from '@/lib/chat/use-chat-model-options';
import { useAvailableModels } from '@/lib/hooks/use-available-models';
import { useCommittedConnectivityStatus } from '@/lib/hooks/use-offline-banner-state';
import { useEffectiveTabBarHeight } from '@/lib/tab-bar-clearance';
import { useOrganization } from '@/lib/organization-context';
import { useLocalResetNotice } from '@/lib/persist/use-local-reset-notice';
import {
  DEFAULT_CHAT_FILTERS,
  type ChatListFilters,
  type MergedChatRow,
} from '@/lib/chat/sync/sync-list';
import {
  deleteEverywhere,
  deleteServerSession,
  importServerSession,
} from '@/lib/chat/sync/sync-service';
import {
  useChatSyncGate,
  useChatSyncUploader,
  useDeletedElsewhere,
  useMergedChatList,
} from '@/lib/chat/sync/use-chat-sync';

import { BetaPill } from './beta-pill';
import { ChatRow } from './chat-row';
import { selectChatListSurface } from './chat-list-surface';
import { BackendSettingsControl } from './backend-settings-sheet';
import { LocalResetNoticeCard } from './local-reset-notice';
import { ChatSyncListControls } from './chat-sync-list-controls';

/**
 * The chats a person has, newest first.
 *
 * Several can be running at once: the conversations are held in the registry
 * rather than by whichever screen is mounted, so a chat that is answering is
 * still answering while this list is on screen.
 *
 * It is laid out the way the sessions list is, because a chat is a session of
 * a plainer kind: the same header, the same edge-to-edge rows, and the same
 * button in the same corner for starting one.
 */

const SKELETON_ROW_COUNT = 8;

export function ChatListScreen() {
  const { organizationId } = useOrganization();
  const { authEpoch } = useAuth();
  return <ScopedChatListScreen key={`${authEpoch}:${organizationId ?? 'personal'}`} />;
}

function ScopedChatListScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { organizationId } = useOrganization();
  const place = useChatPlace();
  const tabBarHeight = useEffectiveTabBarHeight();
  const connectivity = useCommittedConnectivityStatus();
  const { notice: localResetNotice, dismiss: dismissLocalResetNotice } = useLocalResetNotice();

  const {
    models,
    isLoading: modelsLoading,
    isError: modelsFailed,
    isFetched: modelsFetched,
    refetch: refetchModels,
  } = useAvailableModels(organizationId ?? undefined);
  const backends = useChatBackends();
  const localModels = useLocalModels();
  const gatewayOptions = useMemo(
    () => models.map(model => ({ ...model, displayId: model.id, showGatewayMetadata: true })),
    [models]
  );
  const options = useChatModelOptions(gatewayOptions, backends, localModels);

  // The catalog is what tells a session its context window, and a session with
  // no window never compacts. It is handed over as it arrives.
  useEffect(() => {
    rememberModelFacts(models);
  }, [models]);

  const {
    chats,
    isLoading,
    isError,
    isSuccess: listAnswered,
    refetch,
    remove,
    rename,
  } = useChatList(place);

  // Sync: the flag and the per-account setting together. Off, the list is
  // exactly the device's chats, as before; on, server sessions merge in.
  const gate = useChatSyncGate(place);
  useChatSyncUploader(place, gate.enabled);
  const [filters, setFilters] = useState<ChatListFilters>(DEFAULT_CHAT_FILTERS);
  const merged = useMergedChatList({ place, enabled: gate.enabled, chats, filters });
  const rows: readonly MergedChatRow[] = gate.enabled
    ? merged.rows
    : chats.map(chat => ({
        key: chat.sessionId,
        title: chat.title,
        preview: chat.preview,
        model: chat.model,
        updatedAt: chat.updatedAt,
        live: false,
        archived: false,
        origin: null,
        localSessionId: chat.sessionId,
        serverSessionId: null,
        chat,
      }));
  const rowsByKey = useMemo(() => new Map(rows.map(row => [row.key, row])), [rows]);
  useDeletedElsewhere(
    useCallback(() => {
      toast.error(t('modelChat.sync.deletedElsewhere'), { position: 'top-center' });
      refetch();
      merged.refetch();
    }, [merged, refetch, t])
  );

  // There is no picker here: a chat starts on the model the latest one is on,
  // and the conversation's own picker switches it from its next message.
  const selectedModel = defaultChatModel({
    options,
    latestChatModel: chats[0]?.model,
    catalogLoading: modelsLoading,
  });

  const nameOf = useCallback(
    (id: string) =>
      // Kilo's own Auto models arrive with an English catalogue name that no
      // catalog translates, so the row resolves it the same way the composer's
      // chip does and the two never disagree.
      autoModelLabel(id, options.find(model => model.id === id)?.name ?? ''),
    [options]
  );

  /* Starting a chat discovers the Kilo MCP server before the session opens, and
     a slow or offline one takes up to four seconds to give up. The button says
     it is working for that whole time, so a tap never reads as one that was
     ignored — and the second tap a silent wait invites cannot open a second
     chat. The ref is the guard, not the state: two presses in one frame both
     read the state as it was before the first one re-rendered. */
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);

  const start = useCallback(() => {
    if (startingRef.current) {
      return;
    }
    const model = selectedModel;
    if (place === null || model === undefined) {
      return;
    }
    startingRef.current = true;
    setStarting(true);
    void (async () => {
      try {
        const sessionId = await newChat(place, {
          model,
          effort: null,
        });
        // Whatever the last attempt failed with is moot once a chat starts.
        toast.dismiss('chat-start-failed');
        router.push(`/(app)/(tabs)/(4_chat)/${sessionId}` as Href);
      } catch (error) {
        /* Starting the chat or opening its session failed. Saying nothing would
           read as a button that does not work, and a toast that dismissed itself
           four seconds later was missed by whoever looked away. The reason stays
           until it is dismissed, at the top so it never covers the tab bar. */
        toast.error(error instanceof Error ? error.message : t('common.somethingWentWrong'), {
          id: 'chat-start-failed',
          position: 'top-center',
          duration: Infinity,
          closeButton: true,
        });
      } finally {
        startingRef.current = false;
        setStarting(false);
      }
    })();
  }, [selectedModel, place, router, t]);

  const open = useCallback(
    (key: string) => {
      const row = rowsByKey.get(key);
      if (row === undefined) {
        return;
      }
      if (row.localSessionId !== null) {
        router.push(`/(app)/(tabs)/(4_chat)/${row.localSessionId}` as Href);
        return;
      }
      if (place === null || row.serverSessionId === null) {
        return;
      }
      void (async () => {
        const sessionId = await importServerSession(
          place,
          row.serverSessionId as string,
          selectedModel ?? ''
        );
        if (sessionId !== null) {
          refetch();
          router.push(`/(app)/(tabs)/(4_chat)/${sessionId}` as Href);
        } else {
          toast.error(t('modelChat.sync.deletedElsewhere'), { position: 'top-center' });
          merged.refetch();
        }
      })();
    },
    [merged, place, refetch, router, rowsByKey, selectedModel, t]
  );

  const drop = useCallback(
    (key: string) => {
      const row = rowsByKey.get(key);
      if (row === undefined) {
        return;
      }
      void (async () => {
        if (gate.enabled && place !== null && row.serverSessionId !== null) {
          if (row.localSessionId !== null) {
            await deleteEverywhere(place, row.localSessionId);
          } else {
            await deleteServerSession(place, row.serverSessionId);
          }
          refetch();
          merged.refetch();
          return;
        }
        if (row.localSessionId !== null) {
          await remove(row.localSessionId);
        }
      })();
    },
    [gate.enabled, merged, place, refetch, remove, rowsByKey]
  );

  const renameRow = useCallback(
    async (key: string, title: string) => {
      const row = rowsByKey.get(key);
      if (row === undefined) {
        return;
      }
      if (row.localSessionId !== null) {
        await rename(row.localSessionId, title);
        return;
      }
      if (place === null || row.serverSessionId === null) {
        return;
      }
      const sessionId = await importServerSession(place, row.serverSessionId, selectedModel ?? '');
      if (sessionId !== null) {
        await rename(sessionId, title);
        refetch();
        merged.refetch();
      }
    },
    [merged, place, refetch, rename, rowsByKey, selectedModel]
  );

  const renderItem = useCallback(
    ({ item, index }: { item: MergedChatRow; index: number }) => (
      <ChatRow
        chat={
          item.chat ?? {
            sessionId: item.key,
            model: item.model,
            title: item.title,
            preview: item.preview,
            updatedAt: item.updatedAt,
          }
        }
        modelName={nameOf(item.model)}
        last={index === rows.length - 1}
        onPress={open}
        onDelete={drop}
        onRename={renameRow}
        origin={item.origin}
        liveRemote={item.live}
        deleteEverywhere={gate.enabled && item.serverSessionId !== null}
      />
    ),
    [drop, gate.enabled, nameOf, open, renameRow, rows.length]
  );

  // Nothing to start a chat with is nothing for the button to do, and an empty
  // list carries its own button, so the corner one would be the second. The
  // body is decided by the two reads' own provenance (see
  // `selectChatListSurface`), so an unanswered read can never read as "no
  // chats": the corner button follows the same body.
  const serverFailed =
    gate.enabled &&
    (merged.surface.kind === 'failed' || merged.surface.kind === 'retryable-error');
  const surface = selectChatListSurface({
    chatCount: rows.length,
    listAnswered:
      listAnswered &&
      (!gate.enabled || merged.surface.kind === 'ready' || merged.surface.kind === 'off'),
    listFailed: isError || serverFailed,
    listLoading: isLoading || (gate.enabled && merged.surface.kind === 'loading'),
    hasPlace: place !== null,
    catalogAnswered: modelsFetched && !modelsFailed,
    catalogLoading: modelsLoading,
    // The model a New chat would start on. A catalog that cannot load does not
    // remove a model that is already known (cached rows, a backend, an
    // on-device model), so an answered list keeps its empty state and its
    // button instead of a full-screen catalog error.
    catalogStartable: selectedModel !== undefined,
    offline: connectivity === 'offline',
  });
  const empty = surface.kind === 'empty';
  const failed = surface.kind === 'list-error' || surface.kind === 'catalog-error';
  const showFab = !empty && !failed && place !== null && selectedModel !== undefined;

  const fabStyle = useMemo(
    () => ({
      bottom: tabBarHeight + FAB_MARGIN,
      right: FAB_GUTTER,
      width: FAB_SIZE,
      height: FAB_SIZE,
    }),
    [tabBarHeight]
  );

  const listStyle = useMemo(
    () => ({ paddingBottom: tabBarHeight + (showFab ? FAB_SIZE + FAB_MARGIN : 0) }),
    [showFab, tabBarHeight]
  );

  function renderBody() {
    if (surface.kind === 'list-error') {
      return (
        <QueryError
          variant="server"
          // i18n-dup-ok: 'modelChat.list.loadFailed' was renamed from the base catalog's
          // quickChat.historyRetry in the harness-chat rebuild; no other live key carries it.
          title={t(serverFailed ? 'modelChat.sync.listLoadFailed' : 'modelChat.list.loadFailed')}
          onRetry={() => {
            refetch();
            merged.refetch();
          }}
        />
      );
    }
    if (surface.kind === 'catalog-error') {
      return (
        <QueryError
          // Offline names the connection; anything else is the catalog's own
          // failure. Retry asks either read again.
          variant={surface.offline ? 'offline' : 'server'}
          title={surface.offline ? undefined : t('common.couldNotLoadModels')}
          onRetry={() => {
            void refetchModels();
          }}
        />
      );
    }
    if (surface.kind === 'loading') {
      return (
        <View className="pt-1">
          {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
            <RowSkeleton
              key={index}
              variant="session"
              subtitle
              last={index === SKELETON_ROW_COUNT - 1}
            />
          ))}
        </View>
      );
    }
    if (surface.kind === 'empty') {
      return (
        <EmptyState
          icon={MessageCircle}
          // i18n-dup-ok: 'modelChat.empty.title' was renamed from the base catalog's
          // quickChat.empty.title in the harness-chat rebuild; no other live key carries it.
          title={t('modelChat.empty.title')}
          // i18n-dup-ok: 'modelChat.empty.description' was renamed from the base catalog's
          // quickChat.empty.description in the harness-chat rebuild; no other live key carries it.
          description={t('modelChat.empty.description')}
          action={
            <StateAction
              label={t('modelChat.list.new')}
              icon={MessageCirclePlus}
              onPress={start}
              loading={starting}
              disabled={selectedModel === undefined}
            />
          }
        />
      );
    }
    return (
      <FlashList
        data={[...rows]}
        keyExtractor={row => row.key}
        renderItem={renderItem}
        maintainVisibleContentPosition={{ disabled: true }}
        contentContainerStyle={listStyle}
        onEndReached={() => {
          if (merged.hasNextPage) {
            merged.fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.5}
      />
    );
  }

  return (
    <StateSurfaceInsets bottomInset={tabBarHeight + (showFab ? FAB_SIZE + FAB_MARGIN : 0)}>
      <View className="flex-1 bg-background">
        <ScreenHeader
          title={t('common.chat')}
          titleAccessory={<BetaPill />}
          size="large"
          showBackButton={false}
          headerRight={<BackendSettingsControl />}
          inlineActions={<ContextControl />}
          allowInlineActionsStacking={false}
          inlineActionsMinWidth={CONTEXT_CONTROL_INLINE_MIN_DP}
        />
        {/* Above every body kind: an emptied list must never read as an
            ordinary empty state, so the explanation outranks what remains. */}
        {localResetNotice.kind === 'present' ? (
          <LocalResetNoticeCard onDismiss={dismissLocalResetNotice} />
        ) : null}
        {gate.enabled ? <ChatSyncListControls filters={filters} onChange={setFilters} /> : null}
        <View className="flex-1">{renderBody()}</View>
        {showFab && (
          <Fab
            label={t('modelChat.list.new')}
            testID="chat-new-fab"
            busy={starting}
            onPress={start}
            style={fabStyle}
          />
        )}
      </View>
    </StateSurfaceInsets>
  );
}
