import { FlashList } from '@shopify/flash-list';
import { type Href, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { toast } from 'sonner-native';
import { useTranslation } from 'react-i18next';

import { FAB_MARGIN, FAB_SIZE } from '@/components/agents/session-list-content';
import { StateSurfaceInsets } from '@/components/centered-state-surface';
import { ContextControl } from '@/components/context-control';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { Button } from '@/components/ui/button';
import { MessageCircle, Plus } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
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
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useOrganization } from '@/lib/organization-context';
import { getEffectiveTabBarHeight } from '@/lib/tab-bar-layout';

import { BetaPill } from './beta-pill';
import { ChatRow } from './chat-row';
import { BackendSettingsControl } from './backend-settings-sheet';

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
  const place = useChatPlace();
  const { bottom } = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const tabBarHeight = useMemo(
    () => getEffectiveTabBarHeight({ bottomInset: bottom, platform: Platform.OS, fontScale }),
    [bottom, fontScale]
  );

  const {
    models,
    isLoading: modelsLoading,
    isError: modelsFailed,
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

  const { chats, isLoading, isError, refetch, remove, rename } = useChatList(place);

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
        onRename={rename}
      />
    ),
    [chats.length, drop, nameOf, open, rename]
  );

  // Nothing to start a chat with is nothing for the button to do, and an empty
  // list carries its own button, so the corner one would be the second.
  const empty = !isLoading && chats.length === 0;
  const failed = isError || (modelsFailed && options.length === 0 && chats.length === 0);
  const showFab = !empty && !failed && place !== null && selectedModel !== undefined;

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
        <QueryError
          variant="server"
          // i18n-dup-ok: 'modelChat.list.loadFailed' was renamed from the base catalog's
          // quickChat.historyRetry in the harness-chat rebuild; no other live key carries it.
          title={t('modelChat.list.loadFailed')}
          onRetry={refetch}
        />
      );
    }
    if (modelsFailed && options.length === 0 && chats.length === 0) {
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
          // i18n-dup-ok: 'modelChat.empty.title' was renamed from the base catalog's
          // quickChat.empty.title in the harness-chat rebuild; no other live key carries it.
          title={t('modelChat.empty.title')}
          // i18n-dup-ok: 'modelChat.empty.description' was renamed from the base catalog's
          // quickChat.empty.description in the harness-chat rebuild; no other live key carries it.
          description={t('modelChat.empty.description')}
          action={
            <Button
              onPress={start}
              loading={starting}
              disabled={selectedModel === undefined}
              accessibilityLabel={t('modelChat.list.new')}
            >
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
                // An explicit line height, not `leading-9`: the scale token
                // measures a wrong height on Android (the title laid out
                // 851dp tall, so the header filled the screen and the list
                // below it was off-screen), while the same 2.25rem written in
                // pixels lays the title out at 36dp on both platforms.
                className="text-[30px] font-semibold leading-[36px] text-foreground"
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
          headerRight={<BackendSettingsControl />}
        />
        {/* The account every read on this screen is scoped to: the chat list
            (`useChatPlace`), the model catalogue, and the empty state below.
            Switching it remounts the scoped screen, so without the name here a
            person in two workspaces watches their conversations disappear with
            nothing saying which workspace they are now in. It is the same
            switchable control Home and the new-session screen put in their
            header — the active account's name and the account picker sheet, no
            copy of its own — and it holds one row in every scope (Personal and
            a single membership included), so the list never moves when the
            account list resolves or changes. It sits at the header's own
            gutter and on its own row: the 30px title already fills the title
            row, so a trailing cluster would paint over it on a phone. */}
        <View className="px-[22px] pb-1">
          <ContextControl />
        </View>
        <View className="flex-1">{renderBody()}</View>
        {showFab && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('modelChat.list.new')}
            accessibilityState={{ disabled: starting, busy: starting }}
            testID="chat-new-fab"
            disabled={starting}
            onPress={start}
            className="absolute items-center justify-center rounded-full bg-primary shadow-lg shadow-[#00000040] active:opacity-80"
            style={fabStyle}
          >
            {starting ? (
              <ActivityIndicator size="small" color={colors.primaryForeground} />
            ) : (
              <Plus size={24} color={colors.primaryForeground} />
            )}
          </Pressable>
        )}
      </View>
    </StateSurfaceInsets>
  );
}
