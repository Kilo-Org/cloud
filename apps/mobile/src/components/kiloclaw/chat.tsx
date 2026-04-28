import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { Image as ExpoImage } from 'expo-image'; // eslint-disable-line no-restricted-imports -- raw expo-image needed for Stream Chat SDK ImageComponent prop
import * as Notifications from 'expo-notifications';
import { type Channel as StreamChannel, StreamChat } from 'stream-chat';
import { Channel, Chat, MessageInput, MessageList, OverlayProvider } from 'stream-chat-expo';
import { toast } from 'sonner-native';

import { KiloClawMessageAvatar } from '@/components/kiloclaw/chat-avatar';
import { ChatPlaceholder } from '@/components/kiloclaw/chat-placeholder';
import { ChatHeader, ChatShell } from '@/components/kiloclaw/chat-shell';
import { useBotOnlineStatus } from '@/components/kiloclaw/chat-hooks';
import { NotificationPrompt } from '@/components/kiloclaw/notification-prompt';
import { useStreamChatTheme } from '@/components/kiloclaw/chat-theme';
import { useAppLifecycle } from '@/lib/hooks/use-app-lifecycle';
import { useStreamChatCredentials } from '@/lib/hooks/use-kiloclaw-queries';
import { setLastActiveInstance } from '@/lib/last-active-instance';
import { parseNotificationData, setActiveChatInstance } from '@/lib/notifications';
import { useTRPC } from '@/lib/trpc';

type KiloClawChatProps = {
  instanceId: string;
  name: string;
  enabled: boolean;
  organizationId?: string | null;
};

type UnreadCountsData = { channelId: string; badgeCount: number }[];

export function KiloClawChat({
  instanceId,
  name,
  enabled,
  organizationId,
}: Readonly<KiloClawChatProps>) {
  const { data: creds, isLoading, error } = useStreamChatCredentials(organizationId, enabled);
  const trpc = useTRPC();
  const { isActive } = useAppLifecycle();
  const isFocusedRef = useRef(false);

  const queryClient = useQueryClient();
  const unreadCountsKey = useMemo(() => trpc.user.getUnreadCounts.queryOptions().queryKey, [trpc]);

  const { mutate: markChatRead } = useMutation(
    trpc.user.markChatRead.mutationOptions({
      onMutate: async ({ channelId }) => {
        await queryClient.cancelQueries({ queryKey: unreadCountsKey });
        const previous = queryClient.getQueryData<UnreadCountsData>(unreadCountsKey);
        queryClient.setQueryData<UnreadCountsData>(unreadCountsKey, old =>
          (old ?? []).filter(row => row.channelId !== channelId)
        );
        return { previous };
      },
      onSuccess: ({ badgeCount }) => {
        void Notifications.setBadgeCountAsync(badgeCount);
      },
      onError: (err: { message: string }, _input, context) => {
        if (context?.previous) {
          queryClient.setQueryData<UnreadCountsData>(unreadCountsKey, context.previous);
        }
        toast.error(err.message || 'Failed to update badge count');
      },
      onSettled: () => {
        void queryClient.invalidateQueries({ queryKey: unreadCountsKey });
      },
    })
  );

  useFocusEffect(
    useCallback(() => {
      isFocusedRef.current = true;
      setActiveChatInstance(instanceId);
      setLastActiveInstance(instanceId);
      markChatRead({ channelId: instanceId });

      // If a notification for this chat arrives while the screen is already open it is
      // visually suppressed, but the DO still incremented the server-side count. Clear
      // it immediately so the badge never drifts above 0 while the user is reading.
      const subscription = Notifications.addNotificationReceivedListener(notification => {
        const data = parseNotificationData(notification.request.content.data);
        if (data?.type === 'chat' && data.instanceId === instanceId) {
          markChatRead({ channelId: instanceId });
        }
      });

      return () => {
        isFocusedRef.current = false;
        setActiveChatInstance(null);
        subscription.remove();
      };
    }, [instanceId, markChatRead])
  );

  // Clear badge when the app returns to the foreground while this chat is focused.
  // Notifications received in the background do not fire the listener above, and
  // useFocusEffect does not re-run on app resume (focus is a navigation concept,
  // not an app-state one), so without this the badge stays stuck after backgrounding.
  useEffect(() => {
    if (isActive && isFocusedRef.current) {
      markChatRead({ channelId: instanceId });
    }
  }, [isActive, instanceId, markChatRead]);

  if (!enabled) {
    return (
      <ChatShell instanceId={instanceId} name={name}>
        <ChatPlaceholder message="Chat is available when the machine is running." />
      </ChatShell>
    );
  }

  if (isLoading) {
    return (
      <ChatShell instanceId={instanceId} name={name}>
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      </ChatShell>
    );
  }

  if (error) {
    return (
      <ChatShell instanceId={instanceId} name={name}>
        <ChatPlaceholder message="Failed to load chat. Please try again." />
      </ChatShell>
    );
  }

  if (!creds) {
    return (
      <ChatShell instanceId={instanceId} name={name}>
        <ChatPlaceholder message="Chat requires an upgrade. Use 'Upgrade to Latest' on the dashboard." />
      </ChatShell>
    );
  }

  return (
    <StreamChatUI
      instanceId={instanceId}
      name={name}
      apiKey={creds.apiKey}
      userId={creds.userId}
      channelId={creds.channelId}
      organizationId={organizationId}
    />
  );
}

function StreamChatUI({
  instanceId,
  name,
  apiKey,
  userId,
  channelId,
  organizationId,
}: {
  instanceId: string;
  name: string;
  apiKey: string;
  userId: string;
  channelId: string;
  organizationId?: string | null;
}) {
  const { bottom } = useSafeAreaInsets();
  const [headerHeight, setHeaderHeight] = useState(0);
  const chatTheme = useStreamChatTheme();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const tokenProvider = useCallback(async () => {
    const opts = organizationId
      ? trpc.organizations.kiloclaw.getStreamChatCredentials.queryOptions(
          { organizationId },
          { staleTime: 0 }
        )
      : trpc.kiloclaw.getStreamChatCredentials.queryOptions(undefined, { staleTime: 0 });
    const creds = await queryClient.fetchQuery(opts);
    if (!creds?.userToken) {
      throw new Error('Failed to fetch Stream Chat credentials');
    }
    return creds.userToken;
  }, [queryClient, trpc, organizationId]);

  const [client, setClient] = useState<StreamChat | null>(null);
  const [channel, setChannel] = useState<StreamChannel | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  useEffect(() => {
    const chatClient = StreamChat.getInstance(apiKey);

    let cancelled = false;
    setConnectError(null);

    const connect = async () => {
      try {
        // Await disconnect to prevent tokenManager.reset() from racing with the new connection
        if (chatClient.userID) {
          await chatClient.disconnectUser();
        }
        if (cancelled) {
          return;
        }
        await chatClient.connectUser({ id: userId }, tokenProvider);
        const ch = chatClient.channel('messaging', channelId);
        await ch.watch({ presence: true });
        // eslint-disable-next-line typescript-eslint/no-unnecessary-condition -- cancelled can change across awaits
        if (!cancelled) {
          setClient(chatClient);
          setChannel(ch);
        }
      } catch (error) {
        if (!cancelled) {
          setConnectError(error instanceof Error ? error.message : 'Failed to connect to chat.');
        }
      }
    };

    void connect();

    return () => {
      cancelled = true;
      setClient(null);
      setChannel(null);
    };
  }, [apiKey, userId, channelId, tokenProvider]);

  // Gracefully close/reopen the websocket on background/foreground.
  // This preserves the client and channel state (no disconnect/reconnect).
  const { isActive } = useAppLifecycle();
  const wasActiveRef = useRef(isActive);
  useEffect(() => {
    if (client) {
      if (wasActiveRef.current && !isActive) {
        void client.closeConnection();
      } else if (!wasActiveRef.current && isActive) {
        void client.openConnection();
      }
    }
    wasActiveRef.current = isActive;
  }, [client, isActive]);

  // Bot presence tracking
  const sandboxId = channelId.replace(/^default-/, '');
  const botUserId = `bot-${sandboxId}`;
  const botOnline = useBotOnlineStatus(client, channel, botUserId);

  if (connectError) {
    return (
      <ChatShell instanceId={instanceId} name={name}>
        <ChatPlaceholder message={connectError} />
      </ChatShell>
    );
  }

  if (!client || !channel) {
    return (
      <ChatShell instanceId={instanceId} name={name}>
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      </ChatShell>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <View
        onLayout={e => {
          setHeaderHeight(e.nativeEvent.layout.height);
        }}
      >
        <ChatHeader instanceId={instanceId} title={name} botOnline={botOnline} />
      </View>
      <View className="flex-1" style={{ paddingBottom: bottom }}>
        <OverlayProvider value={{ style: chatTheme }}>
          {/* eslint-disable-next-line typescript-eslint/no-unsafe-assignment -- expo-image is API-compatible with RN Image */}
          <Chat client={client} style={chatTheme} ImageComponent={ExpoImage as never}>
            <Channel
              channel={channel}
              keyboardVerticalOffset={headerHeight}
              MessageAvatar={KiloClawMessageAvatar}
            >
              <NotificationPrompt enabled={Boolean(channel)} />
              <MessageList />
              <MessageInput />
            </Channel>
          </Chat>
        </OverlayProvider>
      </View>
    </View>
  );
}
