import { FlashList, type ListRenderItem } from '@shopify/flash-list';
import { type TFunction } from 'i18next';
import { View } from 'react-native';

import { EmptyState, StateAction } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { MessageCircle, MessageCirclePlus } from '@/components/ui/icons';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { type MergedChatRow } from '@/lib/chat/sync/sync-list';

import { type ChatListSurface } from './chat-list-surface';

/**
 * The list's body: the two error states, the loading skeletons, the empty
 * state, and the rows. Each reads its own provenance from the surface the
 * screen selected, so an unanswered read never paints as "no chats".
 */

const SKELETON_ROW_COUNT = 8;

type ChatListBodyProps = {
  readonly surface: ChatListSurface;
  /** The merged read failed, so the retry has to ask it too. */
  readonly serverFailed: boolean;
  readonly rows: readonly MergedChatRow[];
  readonly renderItem: ListRenderItem<MergedChatRow>;
  readonly listStyle: { readonly paddingBottom: number };
  readonly hasNextPage: boolean;
  readonly fetchNextPage: () => void;
  readonly refetchList: () => void;
  readonly refetchMerged: () => void;
  readonly refetchModels: () => void;
  readonly t: TFunction;
  readonly start: () => void;
  readonly starting: boolean;
  readonly selectedModel: string | undefined;
};

export function ChatListBody({
  surface,
  serverFailed,
  rows,
  renderItem,
  listStyle,
  hasNextPage,
  fetchNextPage,
  refetchList,
  refetchMerged,
  refetchModels,
  t,
  start,
  starting,
  selectedModel,
}: Readonly<ChatListBodyProps>) {
  if (surface.kind === 'list-error') {
    return (
      <QueryError
        variant="server"
        // i18n-dup-ok: 'modelChat.list.loadFailed' was renamed from the base catalog's
        // quickChat.historyRetry in the harness-chat rebuild; no other live key carries it.
        title={t(serverFailed ? 'modelChat.sync.listLoadFailed' : 'modelChat.list.loadFailed')}
        onRetry={() => {
          refetchList();
          refetchMerged();
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
          refetchModels();
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
        if (hasNextPage) {
          fetchNextPage();
        }
      }}
      onEndReachedThreshold={0.5}
    />
  );
}
