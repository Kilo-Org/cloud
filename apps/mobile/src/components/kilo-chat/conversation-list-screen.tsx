import { FlashList } from '@shopify/flash-list';
import { useBotStatus, useEventServiceClient } from '@kilocode/kilo-chat-hooks';
import * as Haptics from 'expo-haptics';
import { type Href, useRouter } from 'expo-router';
import { Plus, Settings2 } from 'lucide-react-native';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, View, type ViewStyle } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { QueryError } from '@/components/query-error';
import { ProfileAvatarButton } from '@/components/profile-avatar-button';
import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { chatConversationPath } from '@/lib/kilo-chat-routes';

import { EmptyConversationList } from './empty-conversation-list';
import { groupConversationsByActivity } from './conversation-list-groups';
import { getConversationListContentState } from './conversation-list-state';
import { ConversationRow } from './conversation-row';
import { useKiloChatClient } from './hooks/use-kilo-chat-client';
import {
  useConversations,
  useCreateConversation,
  useLeaveConversation,
} from './hooks/use-conversations';
import { useInstancePresence } from './hooks/use-instance-presence';
import { useNowTicker } from './hooks/use-now-ticker';

type Props = {
  sandboxId: string;
  sandboxLabel: string;
};

type ConversationItem = {
  kind: 'conversation';
  conversation: NonNullable<ReturnType<typeof useConversations>['data']>['conversations'][number];
};

type ConversationHeaderItem = {
  kind: 'header';
  label: string;
};

type ConversationListEntry = ConversationHeaderItem | ConversationItem;

const listStyle = { flex: 1 } satisfies ViewStyle;
const TAB_BAR_FAB_CLEARANCE = 72;
const FAB_SIZE = 56;
const FAB_MARGIN = 16;

function ConversationListSkeleton({ showHeader }: Readonly<{ showHeader?: boolean }>) {
  return (
    <View className="gap-3 px-4 pt-2">
      {showHeader ? <Skeleton className="mx-1 mb-1 h-4 w-24 rounded-md" /> : null}
      {[0, 1, 2, 3].map(i => (
        <View
          key={i}
          className="min-h-16 flex-row items-center gap-3 rounded-xl border border-border bg-card px-4 py-3"
        >
          <Skeleton className="h-10 w-10 rounded-xl" />
          <View className="min-w-0 flex-1 gap-2">
            <Skeleton className="h-5 w-2/3 rounded-md" />
            <Skeleton className="h-4 w-24 rounded-md" />
          </View>
          <Skeleton className="h-10 w-10 rounded-full" />
        </View>
      ))}
    </View>
  );
}

function flattenConversationGroups(
  conversations: NonNullable<ReturnType<typeof useConversations>['data']>['conversations'],
  nowMs: number
): ConversationListEntry[] {
  const entries: ConversationListEntry[] = [];
  for (const group of groupConversationsByActivity(conversations, nowMs)) {
    entries.push({ kind: 'header', label: group.label });
    for (const conversation of group.items) {
      entries.push({ kind: 'conversation', conversation });
    }
  }
  return entries;
}

export function ConversationListScreen({ sandboxId, sandboxLabel }: Props) {
  const router = useRouter();
  const colors = useThemeColors();
  const { bottom } = useSafeAreaInsets();
  const client = useKiloChatClient();
  const eventClient = useEventServiceClient();
  const listQuery = useConversations(client, sandboxId);
  const createConversation = useCreateConversation(client);
  const leaveConversation = useLeaveConversation(client);
  const now = useNowTicker(60_000);
  const [manualRefreshing, setManualRefreshing] = useState(false);

  const hasNextPage = listQuery.hasNextPage;
  const isFetchingNextPage = listQuery.isFetchingNextPage;
  const fetchNextPage = listQuery.fetchNextPage;
  const refetchConversations = listQuery.refetch;
  const listContentContainerStyle = useMemo(
    () =>
      ({
        flexGrow: 1,
        paddingBottom: Math.max(bottom, 16) + TAB_BAR_FAB_CLEARANCE + FAB_SIZE + FAB_MARGIN,
      }) satisfies ViewStyle,
    [bottom]
  );
  const createButtonStyle = useMemo(
    () =>
      ({
        bottom: Math.max(bottom, 16) + TAB_BAR_FAB_CLEARANCE,
        right: 20,
      }) satisfies ViewStyle,
    [bottom]
  );

  useInstancePresence(sandboxId);
  useBotStatus(client, eventClient, sandboxId);

  function handleRowPress(conversationId: string) {
    void Haptics.selectionAsync();
    router.push(chatConversationPath(sandboxId, conversationId));
  }

  function handleCreateAndNavigate() {
    void Haptics.selectionAsync();
    createConversation.mutate(
      { sandboxId },
      {
        onSuccess: result => {
          router.push(chatConversationPath(sandboxId, result.conversationId));
        },
      }
    );
  }

  function handleOpenSettings() {
    void Haptics.selectionAsync();
    router.push(`/(app)/kiloclaw/${sandboxId}/dashboard` as Href);
  }

  function handleLeave(conversationId: string) {
    leaveConversation.mutate({ conversationId, sandboxId });
  }

  const fetchMoreConversations = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) {
      void fetchNextPage({ cancelRefetch: false });
    }
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  const handleRefresh = useCallback(() => {
    void (async () => {
      setManualRefreshing(true);
      try {
        await refetchConversations();
      } finally {
        setManualRefreshing(false);
      }
    })();
  }, [refetchConversations]);

  const contentState = getConversationListContentState({
    isPending: listQuery.isPending,
    isError: listQuery.isError,
    hasData: listQuery.data !== undefined,
  });

  if (contentState === 'loading') {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={sandboxLabel} size="large" className="px-[22px]" />
        <Animated.View entering={FadeIn.duration(200)} className="flex-1">
          <ConversationListSkeleton showHeader />
        </Animated.View>
      </View>
    );
  }

  if (contentState === 'error') {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={sandboxLabel} size="large" className="px-[22px]" />
        <Animated.View entering={FadeIn.duration(200)} className="flex-1">
          <QueryError
            className="flex-1"
            message="Could not load conversations"
            onRetry={() => {
              void listQuery.refetch();
            }}
          />
        </Animated.View>
      </View>
    );
  }

  const conversations = listQuery.data?.conversations ?? [];
  const entries = flattenConversationGroups(conversations, now);

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={sandboxLabel}
        size="large"
        className="px-[22px]"
        headerRight={
          <View className="flex-row items-center gap-2">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open instance settings"
              className="h-10 w-10 items-center justify-center rounded-full active:bg-muted"
              onPress={handleOpenSettings}
            >
              <Settings2 size={20} color={colors.foreground} strokeWidth={1.75} />
            </Pressable>
            <ProfileAvatarButton />
          </View>
        }
      />
      <Animated.View entering={FadeIn.duration(200)} className="flex-1">
        <FlashList
          style={listStyle}
          contentContainerStyle={listContentContainerStyle}
          data={entries}
          keyExtractor={entry =>
            entry.kind === 'header' ? `header:${entry.label}` : entry.conversation.conversationId
          }
          renderItem={({ item }) =>
            item.kind === 'header' ? (
              <View className="bg-background px-5 pb-2 pt-4">
                <Text variant="eyebrow">{item.label}</Text>
              </View>
            ) : (
              <View className="px-4 pb-3">
                <ConversationRow
                  conversation={item.conversation}
                  sandboxId={sandboxId}
                  onPress={handleRowPress}
                  onLeave={handleLeave}
                />
              </View>
            )
          }
          ListEmptyComponent={
            <EmptyConversationList
              onStart={handleCreateAndNavigate}
              isStarting={createConversation.isPending}
            />
          }
          ListFooterComponent={
            isFetchingNextPage ? (
              <View className="pb-6 pt-1">
                <ConversationListSkeleton />
              </View>
            ) : null
          }
          onEndReached={fetchMoreConversations}
          onEndReachedThreshold={0.5}
          refreshControl={
            <RefreshControl
              refreshing={manualRefreshing}
              onRefresh={handleRefresh}
              colors={[colors.mutedForeground]}
              tintColor={colors.mutedForeground}
            />
          }
        />
      </Animated.View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="New conversation"
        disabled={createConversation.isPending}
        onPress={handleCreateAndNavigate}
        className="absolute h-14 w-14 items-center justify-center rounded-full bg-primary shadow-lg shadow-black/25 active:opacity-80 disabled:opacity-60"
        style={createButtonStyle}
      >
        {createConversation.isPending ? (
          <ActivityIndicator size="small" color={colors.primaryForeground} />
        ) : (
          <Plus size={24} color={colors.primaryForeground} />
        )}
      </Pressable>
    </View>
  );
}
