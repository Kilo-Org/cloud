import { useActionSheet } from '@expo/react-native-action-sheet';
import { type ExecApprovalDecision, type Message } from '@kilocode/kilo-chat';
import * as Crypto from 'expo-crypto';
import { useCallback, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { toast } from 'sonner-native';

import { ConversationHeader } from './conversation-header';
import { EditMessageModal } from './edit-message-modal';
import { canEditOrDeleteMessage, editableTextForMessage } from './message-actions';
import { MessageInput } from './message-input';
import { MessageList } from './message-list';
import { TypingIndicator } from './typing-indicator';
import { useConversationPresence } from './hooks/use-conversation-presence';
import { useConversationEventSubscription } from './hooks/use-conversation-event-subscription';
import { useKiloChatClient } from './hooks/use-kilo-chat-client';
import { useMarkRead } from './hooks/use-mark-read';
import {
  useAddReaction,
  useDeleteMessage,
  useEditMessage,
  useExecuteAction,
  useMessageCacheUpdater,
  useMessages,
  useRemoveReaction,
  useSendMessage,
} from './hooks/use-messages';
import { useTypingIndicator } from './hooks/use-typing-indicator';
import { useCurrentUserId } from './hooks/use-current-user-id';
import { setActiveChatLocation } from '@/lib/notifications';

type Props = { sandboxId: string; conversationId: string; conversationTitle: string };

export function ConversationScreen({ sandboxId, conversationId, conversationTitle }: Props) {
  const { showActionSheetWithOptions } = useActionSheet();
  const client = useKiloChatClient();
  const currentUserId = useCurrentUserId();
  const [editingMessage, setEditingMessage] = useState<{ message: Message; text: string } | null>(
    null
  );

  const messagesQuery = useMessages(client, conversationId);
  const messages = messagesQuery.data?.messages ?? [];
  const hasOlder = messagesQuery.hasNextPage;
  const fetchOlder = useCallback(() => {
    if (messagesQuery.hasNextPage && !messagesQuery.isFetchingNextPage) {
      void messagesQuery.fetchNextPage();
    }
  }, [messagesQuery]);

  const sendMutation = useSendMessage(client, conversationId, currentUserId);
  const executeAction = useExecuteAction(client, conversationId, currentUserId);
  const addReaction = useAddReaction(client, conversationId, currentUserId);
  const removeReaction = useRemoveReaction(client, conversationId, currentUserId);
  const editMessage = useEditMessage(client, conversationId);
  const deleteMessage = useDeleteMessage(client, conversationId);
  const typing = useTypingIndicator({ client, sandboxId, conversationId, currentUserId });
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
  const handleLongPressMessage = useCallback(
    (message: Message) => {
      if (!canEditOrDeleteMessage(message, currentUserId)) {
        return;
      }

      const editableText = editableTextForMessage(message);
      const options = editableText === null ? ['Delete', 'Cancel'] : ['Edit', 'Delete', 'Cancel'];
      const deleteIndex = editableText === null ? 0 : 1;
      const cancelButtonIndex = options.length - 1;

      showActionSheetWithOptions(
        {
          options,
          cancelButtonIndex,
          destructiveButtonIndex: deleteIndex,
        },
        selectedIndex => {
          if (selectedIndex === undefined || selectedIndex === cancelButtonIndex) {
            return;
          }
          if (editableText !== null && selectedIndex === 0) {
            setEditingMessage({ message, text: editableText });
            return;
          }
          if (selectedIndex === deleteIndex) {
            Alert.alert('Delete message?', 'This cannot be undone.', [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Delete',
                style: 'destructive',
                onPress: () => {
                  deleteMessage.mutate({ messageId: message.id, conversationId });
                },
              },
            ]);
          }
        }
      );
    },
    [conversationId, currentUserId, deleteMessage, showActionSheetWithOptions]
  );

  const handleSaveEdit = useCallback(
    (text: string) => {
      if (!editingMessage) {
        return;
      }
      editMessage.mutate({
        messageId: editingMessage.message.id,
        conversationId,
        content: [{ type: 'text', text }],
        timestamp: Date.now(),
      });
      setEditingMessage(null);
    },
    [conversationId, editMessage, editingMessage]
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
          onLongPressMessage={handleLongPressMessage}
          onReactionPress={handleReactionPress}
        />
        <TypingIndicator isTyping={typing.isTyping} name={typing.name} />
        <MessageInput onSend={handleSend} disabled={sendMutation.isPending} />
      </KeyboardAvoidingView>
      <EditMessageModal
        visible={editingMessage !== null}
        initialText={editingMessage?.text ?? ''}
        onCancel={() => {
          setEditingMessage(null);
        }}
        onSave={handleSaveEdit}
      />
    </View>
  );
}
