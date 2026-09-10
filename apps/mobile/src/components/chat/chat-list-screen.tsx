import { FlashList } from '@shopify/flash-list';
import { type Href, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo } from 'react';
import { Platform, Pressable, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { FAB_MARGIN, FAB_SIZE } from '@/components/agents/session-list-content';
import { StateSurfaceInsets } from '@/components/centered-state-surface';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { MessageCircle, Plus } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useAuth } from '@/lib/auth/auth-context';
import { rememberModelFacts } from '@/lib/chat/layers';
import { type ChatSummary } from '@/lib/chat/store';
import { chatPlaceOf, newChat, useChatList } from '@/lib/chat/use-chat';
import { useAvailableModels } from '@/lib/hooks/use-available-models';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useOrganization } from '@/lib/organization-context';
import { getEffectiveTabBarHeight } from '@/lib/tab-bar-layout';

import { BetaPill } from './beta-pill';
import { ChatRow } from './chat-row';

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
  const colors = useThemeColors();
  const { organizationId } = useOrganization();
  const { userId } = useCurrentUserId();
  const place = chatPlaceOf(userId, organizationId);
  const { bottom } = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const tabBarHeight = useMemo(
    () => getEffectiveTabBarHeight({ bottomInset: bottom, platform: Platform.OS, fontScale }),
    [bottom, fontScale]
  );

  const {
    models,
    isError: modelsFailed,
    refetch: refetchModels,
  } = useAvailableModels(organizationId ?? undefined);

  // The catalog is what tells a session its context window, and a session with
  // no window never compacts. It is handed over as it arrives.
  useEffect(() => {
    rememberModelFacts(models);
  }, [models]);

  const { chats, isLoading, isError, refetch, remove } = useChatList(place);

  const nameOf = useCallback(
    (id: string) => models.find(model => model.id === id)?.name ?? '',
    [models]
  );

  const start = useCallback(() => {
    const model = models.find(one => one.isPreferred)?.id ?? models[0]?.id;
    if (place === null || model === undefined) {
      return;
    }
    void (async () => {
      const sessionId = await newChat(place, model);
      router.push(`/(app)/(tabs)/(4_chat)/${sessionId}` as Href);
    })();
  }, [models, place, router]);

  const open = useCallback(
    (sessionId: string) => {
      router.push(`/(app)/(tabs)/(4_chat)/${sessionId}` as Href);
    },
    [router]
  );

  const drop = useCallback(
    (sessionId: string) => {
      void remove(sessionId);
    },
    [remove]
  );

  const renderItem = useCallback(
    ({ item, index }: { item: ChatSummary; index: number }) => (
      <ChatRow
        chat={item}
        modelName={nameOf(item.model)}
        last={index === chats.length - 1}
        onPress={open}
        onDelete={drop}
      />
    ),
    [chats.length, drop, nameOf, open]
  );

  // Nothing to start a chat with is nothing for the button to do, and an empty
  // list carries its own button, so the corner one would be the second.
  const empty = !isLoading && chats.length === 0;
  const failed = isError || (modelsFailed && chats.length === 0);
  const showFab = !empty && !failed && place !== null && models.length > 0;

  const fabStyle = useMemo(
    () => ({
      bottom: tabBarHeight + FAB_MARGIN,
      right: 20,
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
    if (isError) {
      return (
        <QueryError variant="server" title={t('modelChat.list.loadFailed')} onRetry={refetch} />
      );
    }
    if (modelsFailed && chats.length === 0) {
      return (
        <QueryError
          variant="server"
          title={t('common.couldNotLoadModels')}
          onRetry={() => {
            void refetchModels();
          }}
        />
      );
    }
    if (isLoading) {
      return (
        <View className="pt-[18px]">
          {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
            <View key={index} className="py-1.5">
              <Skeleton className="mx-[22px] h-[52px] rounded-none" />
            </View>
          ))}
        </View>
      );
    }
    if (empty) {
      return (
        <EmptyState
          icon={MessageCircle}
          title={t('modelChat.empty.title')}
          description={t('modelChat.empty.description')}
          action={
            <Button onPress={start} accessibilityLabel={t('modelChat.list.new')}>
              <Text>{t('modelChat.list.new')}</Text>
            </Button>
          }
        />
      );
    }
    return (
      <FlashList
        data={[...chats]}
        keyExtractor={chat => chat.sessionId}
        renderItem={renderItem}
        // Newest first: a chat that just arrived belongs on screen, and holding
        // the old scroll position would put it above the top of the list.
        maintainVisibleContentPosition={{ disabled: true }}
        contentContainerStyle={listStyle}
      />
    );
  }

  return (
    <StateSurfaceInsets bottomInset={tabBarHeight + (showFab ? FAB_SIZE + FAB_MARGIN : 0)}>
      <View className="flex-1 bg-background">
        <ScreenHeader
          title={t('common.chat')}
          titleContent={
            <View className="flex-row items-center gap-2">
              <Text
                className="text-[30px] font-semibold leading-9 text-foreground"
                numberOfLines={1}
              >
                {t('common.chat')}
              </Text>
              <BetaPill />
            </View>
          }
          size="large"
          showBackButton={false}
          className="px-[22px] pb-1"
        />
        <View className="flex-1">{renderBody()}</View>
        {showFab && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('modelChat.list.new')}
            testID="chat-new-fab"
            onPress={start}
            className="absolute items-center justify-center rounded-full bg-primary shadow-lg shadow-[#00000040] active:opacity-80"
            style={fabStyle}
          >
            <Plus size={24} color={colors.primaryForeground} />
          </Pressable>
        )}
      </View>
    </StateSurfaceInsets>
  );
}
