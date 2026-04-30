import { useAddReaction, useExecuteAction, useRemoveReaction } from '@kilocode/kilo-chat-hooks';
import { type ExecApprovalDecision, type Message } from '@kilocode/kilo-chat';
import * as Crypto from 'expo-crypto';
import { useCallback } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { toast } from 'sonner-native';

import { ConversationHeader } from './conversation-header';
import { MessageInput } from './message-input';
import { MessageList } from './message-list';
import { TypingIndicator } from './typing-indicator';
import { useConversationPresence } from './hooks/use-conversation-presence';
import { useConversationEventSubscription } from './hooks/use-conversation-event-subscription';
import { useKiloChatClient } from './hooks/use-kilo-chat-client';
import { useMarkRead } from './hooks/use-mark-read';
import { useMessageCacheUpdater, useMessages, useSendMessage } from './hooks/use-messages';
import { useCurrentUserId } from './hooks/use-current-user-id';
import { setActiveChatLocation } from '@/lib/notifications';

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
  const executeAction = useExecuteAction(client, conversationId, currentUserId ?? '');
  const addReaction = useAddReaction(client, conversationId, currentUserId ?? '');
  const removeReaction = useRemoveReaction(client, conversationId, currentUserId ?? '');
  const handleSend = useCallback(
    (text: string) => {
      sendMutation.mutate({
        conversationId,
        content: [{ type: 'text', text }],
        clientId: Crypto.randomUUID(),
      });
    },
    [sendMutation, conversationId]
  );
  const handleReactionPress = useCallback(
    (message: Message, emoji: string) => {
      if (!currentUserId) {
        return;
      }
      const hasReacted =
        message.reactions.find(r => r.emoji === emoji)?.memberIds.includes(currentUserId) ?? false;
      if (hasReacted) {
        removeReaction.mutate({ messageId: message.id, emoji });
      } else {
        addReaction.mutate({ messageId: message.id, emoji });
      }
    },
    [addReaction, currentUserId, removeReaction]
  );
  const handleExecuteAction = useCallback(
    (message: Message, groupId: string, value: ExecApprovalDecision) => {
      executeAction.mutate({ messageId: message.id, groupId, value });
    },
    [executeAction]
  );

  useConversationPresence(sandboxId, conversationId);
  useConversationEventSubscription(sandboxId, conversationId);
  const handleActionFailed = useCallback(() => {
    toast.error("Couldn't reach the bot — please try again");
  }, []);
  useMessageCacheUpdater(client, sandboxId, conversationId, undefined, handleActionFailed);

  const markRead = useMarkRead(client);
  useFocusEffect(
    useCallback(() => {
      markRead(sandboxId, conversationId);
      setActiveChatLocation({ sandboxId, conversationId });
      return () => {
        setActiveChatLocation(null);
      };
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
          currentUserId={currentUserId}
          fetchOlder={fetchOlder}
          hasOlder={hasOlder}
          isExecutingAction={executeAction.isPending}
          onExecuteAction={handleExecuteAction}
          onReactionPress={handleReactionPress}
        />
        <TypingIndicator isTyping={false} />
        <MessageInput onSend={handleSend} disabled={sendMutation.isPending} />
      </KeyboardAvoidingView>
    </View>
  );
}
