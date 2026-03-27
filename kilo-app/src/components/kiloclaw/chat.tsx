import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { type Href, useRouter } from 'expo-router';
import { Settings } from 'lucide-react-native';
import { StreamChat, type Channel as StreamChannel, type Event } from 'stream-chat';
import {
  Chat,
  Channel,
  MessageList,
  MessageInput,
  OverlayProvider,
} from 'stream-chat-react-native';

import { ScreenHeader } from '@/components/screen-header';
import { Text } from '@/components/ui/text';
import { useStreamChatCredentials } from '@/lib/hooks/use-kiloclaw';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useTRPC } from '@/lib/trpc';

type KiloClawChatProps = {
  instanceId: string;
  enabled: boolean;
};

export function KiloClawChat({ instanceId, enabled }: Readonly<KiloClawChatProps>) {
  const { data: creds, isLoading, error } = useStreamChatCredentials(enabled);

  if (!enabled) {
    return (
      <ChatShell instanceId={instanceId}>
        <ChatPlaceholder message="Chat is available when the machine is running." />
      </ChatShell>
    );
  }

  if (isLoading) {
    return (
      <ChatShell instanceId={instanceId}>
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      </ChatShell>
    );
  }

  if (error) {
    return (
      <ChatShell instanceId={instanceId}>
        <ChatPlaceholder message="Failed to load chat. Please try again." />
      </ChatShell>
    );
  }

  if (!creds) {
    return (
      <ChatShell instanceId={instanceId}>
        <ChatPlaceholder message="Chat requires an upgrade. Use 'Upgrade to Latest' on the dashboard." />
      </ChatShell>
    );
  }

  return (
    <StreamChatUI
      instanceId={instanceId}
      apiKey={creds.apiKey}
      userId={creds.userId}
      channelId={creds.channelId}
    />
  );
}

// ─── Internal components ────────────────────────────────────────────────────

function ChatShell({
  instanceId,
  children,
}: {
  instanceId: string;
  children: React.ReactNode;
}) {
  return (
    <View className="flex-1 bg-background">
      <ChatHeader instanceId={instanceId} />
      {children}
    </View>
  );
}

function ChatHeader({
  instanceId,
  botOnline,
}: {
  instanceId: string;
  botOnline?: boolean;
}) {
  const router = useRouter();
  const colors = useThemeColors();

  const settingsButton = (
    <Pressable
      onPress={() => {
        router.push(
          `/(app)/(tabs)/(1_kiloclaw)/${instanceId}/dashboard` as Href
        );
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
      title="Chat"
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
      <View
        className={`h-2 w-2 rounded-full ${online ? 'bg-emerald-400' : 'bg-neutral-500'}`}
      />
      <Text className="text-xs text-muted-foreground">
        {online ? 'Online' : 'Offline'}
      </Text>
    </View>
  );
}

function StreamChatUI({
  instanceId,
  apiKey,
  userId,
  channelId,
}: {
  instanceId: string;
  apiKey: string;
  userId: string;
  channelId: string;
}) {
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

    let didCancel = false;

    const connect = async () => {
      try {
        await chatClient.connectUser({ id: userId }, tokenProvider);
        if (didCancel) return;

        const ch = chatClient.channel('messaging', channelId);
        await ch.watch({ presence: true });
        if (didCancel) return;

        setClient(chatClient);
        setChannel(ch);
      } catch (err) {
        if (didCancel) return;
        setConnectError(err instanceof Error ? err.message : 'Failed to connect to chat.');
      }
    };

    void connect();

    return () => {
      didCancel = true;
      void chatClient.disconnectUser();
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
      <ChatShell instanceId={instanceId}>
        <ChatPlaceholder message={connectError} />
      </ChatShell>
    );
  }

  if (!client || !channel) {
    return (
      <ChatShell instanceId={instanceId}>
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      </ChatShell>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ChatHeader instanceId={instanceId} botOnline={botOnline} />
      <OverlayProvider>
        <Chat client={client}>
          <Channel channel={channel}>
            <MessageList />
            <MessageInput />
          </Channel>
        </Chat>
      </OverlayProvider>
    </View>
  );
}

function useBotOnlineStatus(
  client: StreamChat | null,
  channel: StreamChannel | null,
  botUserId: string
): boolean {
  const [online, setOnline] = useState(false);

  useEffect(() => {
    if (!client || !channel) return;

    // Check initial state
    const member = channel.state.members[botUserId];
    setOnline(!!member?.user?.online);

    const handlePresenceChange = (event: Event) => {
      if (event.user?.id === botUserId) {
        setOnline(!!event.user.online);
      }
    };

    client.on('user.presence.changed', handlePresenceChange);
    return () => {
      client.off('user.presence.changed', handlePresenceChange);
    };
  }, [client, channel, botUserId]);

  return online;
}

function ChatPlaceholder({ message }: { message: string }) {
  return (
    <View className="flex-1 items-center justify-center px-6">
      <Text className="text-sm text-muted-foreground text-center">{message}</Text>
    </View>
  );
}
