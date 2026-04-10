import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { Image as ExpoImage } from 'expo-image'; // eslint-disable-line no-restricted-imports -- raw expo-image needed for Stream Chat SDK ImageComponent prop
import { type Channel as StreamChannel, StreamChat } from 'stream-chat';
import { Channel, Chat, MessageInput, MessageList, OverlayProvider } from 'stream-chat-expo';

import { KiloClawMessageAvatar } from '@/components/kiloclaw/chat-avatar';
import { ChatPlaceholder } from '@/components/kiloclaw/chat-placeholder';
import { ChatHeader, ChatShell } from '@/components/kiloclaw/chat-shell';
import { useBotOnlineStatus } from '@/components/kiloclaw/chat-hooks';
import { NotificationPrompt } from '@/components/kiloclaw/notification-prompt';
import { useStreamChatTheme } from '@/components/kiloclaw/chat-theme';
import { useStreamChatCredentials } from '@/lib/hooks/use-kiloclaw-queries';
import { setActiveChatInstance } from '@/lib/notifications';
import { useTRPC } from '@/lib/trpc';

type KiloClawChatProps = {
  instanceId: string;
  name: string;
  enabled: boolean;
  organizationId?: string | null;
};

export function KiloClawChat({
  instanceId,
  name,
  enabled,
  organizationId,
}: Readonly<KiloClawChatProps>) {
  const { data: creds, isLoading, error } = useStreamChatCredentials(organizationId, enabled);

  useFocusEffect(
    useCallback(() => {
      setActiveChatInstance(instanceId);
      return () => {
        setActiveChatInstance(null);
      };
    }, [instanceId])
  );

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
  const appState = useRef(AppState.currentState);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextAppState => {
      if (client) {
        if (appState.current === 'active' && /inactive|background/.exec(nextAppState)) {
          void client.closeConnection();
        } else if (/inactive|background/.exec(appState.current) && nextAppState === 'active') {
          void client.openConnection();
        }
      }
      appState.current = nextAppState;
    });
    return () => {
      subscription.remove();
    };
  }, [client]);

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
