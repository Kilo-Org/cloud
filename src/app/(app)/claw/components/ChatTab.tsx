'use client';

import { createContext, use, useCallback, useEffect, useState } from 'react';
import type { Channel as StreamChannel, Event } from 'stream-chat';
import { useQueryClient } from '@tanstack/react-query';
import { MessageSquare, RotateCw } from 'lucide-react';
import {
  Chat,
  Channel,
  Window,
  MessageList,
  MessageInput,
  MessageSimple,
  Thread,
  useCreateChatClient,
  useChatContext,
  useChannelStateContext,
  useMessageContext,
} from 'stream-chat-react';
import { useStreamChatCredentials } from '@/hooks/useKiloClaw';
import { useTRPC } from '@/lib/trpc/utils';

const BotUserIdContext = createContext<string>('');

type ChatTabProps = {
  /** Only fetch credentials and connect when true (tab is active + instance running). */
  enabled: boolean;
};

export function ChatTab({ enabled }: ChatTabProps) {
  const { data: creds, isLoading, error } = useStreamChatCredentials(enabled);

  if (!enabled) {
    return <ChatPlaceholder message="Chat is available when the machine is running." />;
  }

  if (isLoading) {
    return <ChatPlaceholder message="Connecting to chat…" />;
  }

  if (error) {
    return <ChatPlaceholder message="Failed to load chat — please try again." isError />;
  }

  if (!creds) {
    return (
      <div className="flex h-96 flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full border border-white/10 bg-white/5">
          <MessageSquare className="h-5 w-5 text-muted-foreground" />
        </div>
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-medium">Chat requires an upgrade</p>
          <p className="text-muted-foreground max-w-sm text-sm">
            This instance was provisioned before chat was enabled. Use the{' '}
            <span className="inline-flex items-center gap-1 font-medium text-amber-400">
              <RotateCw className="inline h-3 w-3" />
              Upgrade to Latest
            </span>{' '}
            button above to activate real-time chat with your KiloClaw bot.
          </p>
        </div>
      </div>
    );
  }

  return <StreamChatUI apiKey={creds.apiKey} userId={creds.userId} channelId={creds.channelId} />;
}

// ─── Internal components ────────────────────────────────────────────────────

function StreamChatUI({
  apiKey,
  userId,
  channelId,
}: {
  apiKey: string;
  userId: string;
  channelId: string;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  // Stable token provider that fetches a fresh short-lived token on every call.
  // stream-chat-react calls this when the current token expires (via `exp` claim).
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

  const client = useCreateChatClient({
    apiKey,
    tokenOrProvider: tokenProvider,
    userData: { id: userId },
  });

  const [channel, setChannel] = useState<StreamChannel | undefined>();

  useEffect(() => {
    if (!client) return;
    const ch = client.channel('messaging', channelId);
    void ch.watch({ presence: true });
    setChannel(ch);
    return () => {
      void ch.stopWatching();
    };
  }, [client, channelId]);

  // channelId is "default-{sandboxId}", bot user is "bot-{sandboxId}"
  const sandboxId = channelId.replace(/^default-/, '');
  const botUserId = `bot-${sandboxId}`;

  if (!client || !channel) {
    return <ChatPlaceholder message="Connecting to chat…" />;
  }

  return (
    <BotUserIdContext value={botUserId}>
      <div className="claw-chat-wrapper h-[560px]">
        <Chat client={client} theme="str-chat__theme-dark">
          <Channel channel={channel} Message={ClawMessage}>
            <Window>
              <BotStatusBar botUserId={botUserId} />
              <MessageList />
              <MessageInput />
            </Window>
            <Thread />
          </Channel>
        </Chat>
      </div>
    </BotUserIdContext>
  );
}

function ClawMessage() {
  const botUserId = use(BotUserIdContext);
  const { message } = useMessageContext();
  const isBotThinking =
    message.user?.id === botUserId && !message.text?.trim() && !message.attachments?.length;

  if (isBotThinking) {
    return (
      <div className="claw-thinking-message">
        <span className="claw-thinking-text">Thinking&hellip;</span>
      </div>
    );
  }

  return <MessageSimple />;
}

function useBotOnlineStatus(botUserId: string): boolean {
  const { client } = useChatContext();
  const { channel } = useChannelStateContext();

  const getBotOnline = useCallback((): boolean => {
    const member = channel.state.members[botUserId];
    return !!member?.user?.online;
  }, [channel, botUserId]);

  const [online, setOnline] = useState(getBotOnline);

  useEffect(() => {
    setOnline(getBotOnline());

    const handlePresenceChange = (event: Event) => {
      if (event.user?.id === botUserId) {
        setOnline(!!event.user.online);
      }
    };

    client.on('user.presence.changed', handlePresenceChange);
    return () => {
      client.off('user.presence.changed', handlePresenceChange);
    };
  }, [client, botUserId, getBotOnline]);

  return online;
}

function BotStatusBar({ botUserId }: { botUserId: string }) {
  const online = useBotOnlineStatus(botUserId);

  return (
    <div className="flex items-center gap-2 border-b border-white/10 px-3 py-1.5">
      <span className={`size-2 rounded-full ${online ? 'bg-emerald-400' : 'bg-white/20'}`} />
      <span className="text-xs text-white/50">KiloClaw {online ? 'Online' : 'Offline'}</span>
    </div>
  );
}

function ChatPlaceholder({ message, isError = false }: { message: string; isError?: boolean }) {
  return (
    <div
      className={`flex h-96 items-center justify-center text-sm ${isError ? 'text-destructive' : 'text-muted-foreground'}`}
    >
      {message}
    </div>
  );
}
