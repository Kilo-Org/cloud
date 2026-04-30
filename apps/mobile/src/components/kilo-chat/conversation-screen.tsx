import { useCallback } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { ConversationHeader } from './conversation-header';
import { MessageInput } from './message-input';
import { MessageList } from './message-list';
import { TypingIndicator } from './typing-indicator';
import { useConversationPresence } from './hooks/use-conversation-presence';
import { useKiloChatClient } from './hooks/use-kilo-chat-client';
import { useMarkRead } from './hooks/use-mark-read';
import { useMessages, useSendMessage } from './hooks/use-messages';
import { useCurrentUserId } from './hooks/use-current-user-id';

type Props = { sandboxId: string; conversationId: string; conversationTitle: string };

export function ConversationScreen({ sandboxId, conversationId, conversationTitle }: Props) {
  const client = useKiloChatClient();
  const currentUserId = useCurrentUserId();

  const messagesQuery = useMessages(client, conversationId);
  const messages = messagesQuery.data?.messages ?? [];
  const hasOlder = messagesQuery.hasNextPage;
  const fetchOlder = useCallback(() => {
    if (messagesQuery.hasNextPage && !messagesQuery.isFetchingNextPage) {
      void messagesQuery.fetchNextPage();
    }
  }, [messagesQuery]);

  const sendMutation = useSendMessage(client, conversationId, currentUserId ?? '');
  const handleSend = useCallback(
    (text: string) => {
      sendMutation.mutate({
        conversationId,
        content: [{ type: 'text', text }],
        clientId: crypto.randomUUID(),
      });
    },
    [sendMutation, conversationId]
  );

  useConversationPresence(sandboxId, conversationId);

  const markRead = useMarkRead();
  useFocusEffect(
    useCallback(() => {
      markRead(sandboxId, conversationId);
      // Active-conversation suppression wiring added in PR 5d (Task 50).
    }, [sandboxId, conversationId, markRead])
  );

  return (
    <View className="flex-1">
      <ConversationHeader title={conversationTitle} />
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <MessageList
          messages={messages}
          conversationId={conversationId}
          currentUserId={currentUserId}
          fetchOlder={fetchOlder}
          hasOlder={hasOlder}
        />
        <TypingIndicator isTyping={false} />
        <MessageInput onSend={handleSend} disabled={sendMutation.isPending} />
      </KeyboardAvoidingView>
    </View>
  );
}
