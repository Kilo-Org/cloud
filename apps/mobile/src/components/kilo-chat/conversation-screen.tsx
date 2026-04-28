import { useCallback } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { toast } from 'sonner-native';

import { formatKiloChatError } from '@kilocode/kilo-chat';
import { setActiveChatConversation } from '@/lib/notifications';

import { useEventSubscription } from './hooks/use-event-subscription';
import { usePresenceSubscription } from './hooks/use-presence-subscription';
import { useMarkRead } from './hooks/use-mark-read';
import { useSendMessage } from './hooks/use-messages';
import { useCurrentUserId } from './hooks/use-current-user-id';
import { ConversationHeader } from './conversation-header';
import { MessageList } from './message-list';
import { MessageInput } from './message-input';

type ConversationScreenProps = {
  sandboxId: string;
  conversationId: string;
};

export function ConversationScreen({
  sandboxId,
  conversationId,
}: Readonly<ConversationScreenProps>) {
  useEventSubscription(sandboxId, conversationId);
  usePresenceSubscription(conversationId);

  const markRead = useMarkRead();
  const currentUserId = useCurrentUserId();
  const sendMessage = useSendMessage(conversationId, currentUserId);

  useFocusEffect(
    useCallback(() => {
      setActiveChatConversation({ sandboxId, conversationId });
      markRead(conversationId);
      return () => {
        setActiveChatConversation(null);
      };
    }, [sandboxId, conversationId, markRead])
  );

  const handleSend = useCallback(
    (text: string) => {
      sendMessage.mutate(
        {
          conversationId,
          content: [{ type: 'text', text }],
          inReplyToMessageId: undefined,
          clientId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        },
        {
          onError: err => {
            toast.error(formatKiloChatError(err, 'Failed to send message'));
          },
        }
      );
    },
    [sendMessage, conversationId]
  );

  return (
    <View className="flex-1 bg-background">
      <ConversationHeader conversationId={conversationId} />
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <MessageList sandboxId={sandboxId} conversationId={conversationId} />
        <MessageInput onSend={handleSend} isSending={sendMessage.isPending} />
      </KeyboardAvoidingView>
    </View>
  );
}
