import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { type Href, useRouter } from 'expo-router';
import { Image as ExpoImage } from 'expo-image'; // eslint-disable-line no-restricted-imports -- raw expo-image needed for Stream Chat SDK ImageComponent prop
import { Settings } from 'lucide-react-native';
import { type Channel as StreamChannel, StreamChat } from 'stream-chat';
import { Channel, Chat, MessageInput, MessageList, OverlayProvider } from 'stream-chat-expo';

import { useBotOnlineStatus } from '@/components/kiloclaw/chat-hooks';
import { useStreamChatTheme } from '@/components/kiloclaw/chat-theme';
import { ScreenHeader } from '@/components/screen-header';
import { Text } from '@/components/ui/text';
import { useStreamChatCredentials } from '@/lib/hooks/use-kiloclaw';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useTRPC } from '@/lib/trpc';

type KiloClawChatProps = {
  instanceId: string;
  name: string;
  enabled: boolean;
};

export function KiloClawChat({ instanceId, name, enabled }: Readonly<KiloClawChatProps>) {
  const { data: creds, isLoading, error } = useStreamChatCredentials(enabled);

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
    />
  );
}

// ─── Internal components ────────────────────────────────────────────────────

function ChatShell({
  instanceId,
  name,
  children,
}: {
  instanceId: string;
  name: string;
  children: React.ReactNode;
}) {
  return (
    <View className="flex-1 bg-background">
      <ChatHeader instanceId={instanceId} title={name} />
      {children}
    </View>
  );
}

function ChatHeader({
  instanceId,
  title,
  botOnline,
}: {
  instanceId: string;
  title: string;
  botOnline?: boolean;
}) {
  const router = useRouter();
  const colors = useThemeColors();

  const settingsButton = (
    <Pressable
      onPress={() => {
        router.push(`/(app)/(tabs)/(1_kiloclaw)/${instanceId}/dashboard` as Href);
      }}
      hitSlop={12}
      accessibilityLabel="Settings"
      className="active:opacity-70"
    >
      <Settings size={20} color={colors.foreground} />
    </Pressable>
  );

  return (
    <ScreenHeader
      title={title}
      headerRight={
        <View className="flex-row items-center gap-3">
          {botOnline !== undefined && <BotStatusIndicator online={botOnline} />}
          {settingsButton}
        </View>
      }
    />
  );
}

function BotStatusIndicator({ online }: { online: boolean }) {
  return (
    <View className="flex-row items-center gap-1.5">
      <View className={`h-2 w-2 rounded-full ${online ? 'bg-emerald-400' : 'bg-neutral-500'}`} />
      <Text className="text-xs text-muted-foreground">{online ? 'Online' : 'Offline'}</Text>
    </View>
  );
}

function StreamChatUI({
  instanceId,
  name,
  apiKey,
  userId,
  channelId,
}: {
  instanceId: string;
  name: string;
  apiKey: string;
  userId: string;
  channelId: string;
}) {
  const { bottom } = useSafeAreaInsets();
  const [headerHeight, setHeaderHeight] = useState(0);
  const chatTheme = useStreamChatTheme();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  // Stable token provider — stream-chat calls this when the current token expires.
  const tokenProvider = useCallback(async () => {
    const creds = await queryClient.fetchQuery(
      trpc.kiloclaw.getStreamChatCredentials.queryOptions(undefined, {
        staleTime: 0,
      })
    );
    if (!creds?.userToken) {
      throw new Error('Failed to fetch Stream Chat credentials');
    }
    return creds.userToken;
  }, [queryClient, trpc]);

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
        // cancelled may change across awaits above
        // eslint-disable-next-line typescript-eslint/no-unnecessary-condition
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
            <Channel channel={channel} keyboardVerticalOffset={headerHeight}>
              <MessageList />
              <MessageInput />
            </Channel>
          </Chat>
        </OverlayProvider>
      </View>
    </View>
  );
}

function ChatPlaceholder({ message }: { message: string }) {
  return (
    <View className="flex-1 items-center justify-center px-6">
      <Text className="text-sm text-muted-foreground text-center">{message}</Text>
    </View>
  );
}
