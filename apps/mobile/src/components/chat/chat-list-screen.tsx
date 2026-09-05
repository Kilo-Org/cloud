import { FlashList } from '@shopify/flash-list';
import { type Href, useRouter } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ContextControl } from '@/components/context-control';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { useTabBarBottomPadding } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { MessageCircle, Plus } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useAuth } from '@/lib/auth/auth-context';
import { rememberModelFacts } from '@/lib/chat/layers';
import { type ChatSummary } from '@/lib/chat/store';
import { chatPlaceOf, newChat, useChatList } from '@/lib/chat/use-chat';
import { useAvailableModels } from '@/lib/hooks/use-available-models';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useOrganization } from '@/lib/organization-context';

import { BetaPill } from './beta-pill';
import { ChatRow } from './chat-row';

/**
 * The chats a person has, newest first.
 *
 * Several can be running at once: the conversations are held in the registry
 * rather than by whichever screen is mounted, so a chat that is answering is
 * still answering while this list is on screen.
 */

export function ChatListScreen() {
  const { organizationId } = useOrganization();
  const { authEpoch } = useAuth();
  return <ScopedChatListScreen key={`${authEpoch}:${organizationId ?? 'personal'}`} />;
}

function ScopedChatListScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { organizationId } = useOrganization();
  const { userId } = useCurrentUserId();
  const place = chatPlaceOf(userId, organizationId);
  const bottomPadding = useTabBarBottomPadding();

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
    ({ item }: { item: ChatSummary }) => (
      <ChatRow chat={item} modelName={nameOf(item.model)} onPress={open} onDelete={drop} />
    ),
    [drop, nameOf, open]
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
          title={t('modelChat.list.modelsFailed')}
          onRetry={() => {
            void refetchModels();
          }}
        />
      );
    }
    if (!isLoading && chats.length === 0) {
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
        contentContainerClassName="px-4 pt-2"
        ItemSeparatorComponent={() => <View className="h-2" />}
        contentContainerStyle={{ paddingBottom: bottomPadding + 16 }}
      />
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('modelChat.title')}
        titleContent={
          <View className="flex-row items-center gap-2">
            <Text className="text-[30px] font-semibold leading-9 text-foreground" numberOfLines={1}>
              {t('modelChat.title')}
            </Text>
            <BetaPill />
          </View>
        }
        size="large"
        showBackButton={false}
        context={<ContextControl />}
        headerRight={
          <Button
            variant="ghost"
            size="icon"
            accessibilityLabel={t('modelChat.list.new')}
            onPress={start}
          >
            <Plus size={20} />
          </Button>
        }
      />
      <View className="flex-1">{renderBody()}</View>
    </View>
  );
}
