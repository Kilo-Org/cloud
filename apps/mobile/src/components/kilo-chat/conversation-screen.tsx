/* eslint-disable max-lines */
import { useActionSheet } from '@expo/react-native-action-sheet';
import {
  createMarkReadState,
  finishMarkReadAttempt,
  shouldStartMarkReadAttempt,
  startMarkReadAttempt,
  succeedMarkReadAttempt,
  useAddReaction,
  useDeleteMessage,
  useEditMessage,
  useExecuteAction,
  useRemoveReaction,
} from '@kilocode/kilo-chat-hooks';
import { type ExecApprovalDecision, formatKiloChatError, type Message } from '@kilocode/kilo-chat';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { toast } from 'sonner-native';

import { ConversationHeader } from './conversation-header';
import { executeActionWithMobileFeedback } from './execute-action-feedback';
import { buildMessageActionSheetOptions, getSelectedMessageAction } from './message-actions';
import { MessageInput } from './message-input';
import { MessageList } from './message-list';
import { buildSendMessageVariables, createSendMessageClientId } from './message-presentation';
import { useConversationPresence } from './hooks/use-conversation-presence';
import { useConversationEventSubscription } from './hooks/use-conversation-event-subscription';
import { useMobileTypingState, useTypingSender } from './hooks/use-typing';
import { useKiloChatClient } from './hooks/use-kilo-chat-client';
import { useAppActiveAndFocused } from './hooks/use-app-active-and-focused';
import { useMarkRead } from './hooks/use-mark-read';
import { useMessageCacheUpdater, useMessages, useSendMessage } from './hooks/use-messages';
import { useCurrentUserId } from './hooks/use-current-user-id';
import { TypingIndicator } from './typing-indicator';
import { setActiveChatLocation } from '@/lib/notifications';

type Props = { sandboxId: string; conversationId: string; conversationTitle: string };

function editableText(message: Message): string {
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n');
}

export function ConversationScreen({ sandboxId, conversationId, conversationTitle }: Props) {
  const client = useKiloChatClient();
  const currentUserId = useCurrentUserId();
  const { showActionSheetWithOptions } = useActionSheet();
  const { bottom } = useSafeAreaInsets();
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);

  const messagesQuery = useMessages(client, conversationId);
  const messages = messagesQuery.data?.messages ?? [];
  const latestMessageId = messages.at(-1)?.id ?? null;
  const hasOlder = messagesQuery.hasNextPage;
  const fetchOlder = useCallback(() => {
    if (messagesQuery.hasNextPage && !messagesQuery.isFetchingNextPage) {
      void messagesQuery.fetchNextPage();
    }
  }, [messagesQuery]);

  const sendMutation = useSendMessage(client, conversationId, currentUserId);
  const editMessage = useEditMessage(client, conversationId);
  const deleteMessage = useDeleteMessage(client, conversationId);
  const executeAction = useExecuteAction(client, conversationId, currentUserId);
  const addReaction = useAddReaction(client, conversationId, currentUserId);
  const removeReaction = useRemoveReaction(client, conversationId, currentUserId);
  const { typingMembers, clearTypingForMember } = useMobileTypingState({
    client,
    currentUserId,
    sandboxId,
    conversationId,
  });
  const sendTyping = useTypingSender(client, conversationId);
  const editingText = useMemo(
    () => (editingMessage ? editableText(editingMessage) : ''),
    [editingMessage]
  );
  const handleSend = useCallback(
    (text: string, inReplyToMessageId?: string) => {
      if (editingMessage) {
        editMessage.mutate(
          {
            messageId: editingMessage.id,
            conversationId,
            content: [{ type: 'text', text }],
            timestamp: Date.now(),
          },
          {
            onSuccess: () => {
              setEditingMessage(null);
            },
            onError: err => {
              toast.error(formatKiloChatError(err, 'Failed to edit message'));
            },
          }
        );
        return;
      }
      sendMutation.mutate(
        buildSendMessageVariables({
          conversationId,
          text,
          clientId: createSendMessageClientId(),
          inReplyToMessageId,
        }),
        {
          onSuccess: () => {
            setReplyingTo(null);
          },
        }
      );
    },
    [conversationId, editMessage, editingMessage, sendMutation]
  );
  const handleReactionPress = useCallback(
    (message: Message, emoji: string) => {
      if (!currentUserId) {
        return;
      }
      const hasReacted =
        message.reactions.find(r => r.emoji === emoji)?.memberIds.includes(currentUserId) ?? false;
      if (hasReacted) {
        removeReaction.mutate(
          { messageId: message.id, emoji },
          {
            onError: err => {
              toast.error(formatKiloChatError(err, 'Failed to remove reaction'));
            },
          }
        );
      } else {
        addReaction.mutate(
          { messageId: message.id, emoji },
          {
            onError: err => {
              toast.error(formatKiloChatError(err, 'Failed to add reaction'));
            },
          }
        );
      }
    },
    [addReaction, currentUserId, removeReaction]
  );
  const handleExecuteAction = useCallback(
    (message: Message, groupId: string, value: ExecApprovalDecision) => {
      executeActionWithMobileFeedback({ executeAction, message, groupId, value });
    },
    [executeAction]
  );
  const handleLongPressMessage = useCallback(
    (message: Message) => {
      if (message.deleted) {
        return;
      }
      const isOwnMessage = currentUserId !== null && message.senderId === currentUserId;
      const actionSheet = buildMessageActionSheetOptions({
        isOwnMessage,
        canReact: currentUserId !== null,
        canReply: !message.deliveryFailed,
      });
      showActionSheetWithOptions(
        {
          options: actionSheet.options,
          cancelButtonIndex: actionSheet.cancelButtonIndex,
          destructiveButtonIndex: actionSheet.destructiveButtonIndex,
          title: 'Message actions',
          containerStyle: { paddingBottom: bottom },
        },
        index => {
          const selectedAction = getSelectedMessageAction(actionSheet, index);
          if (!selectedAction) {
            return;
          }

          if (selectedAction.kind === 'reaction') {
            addReaction.mutate(
              { messageId: message.id, emoji: selectedAction.emoji },
              {
                onError: err => {
                  toast.error(formatKiloChatError(err, 'Failed to add reaction'));
                },
              }
            );
            return;
          }
          if (selectedAction.kind === 'reply') {
            setEditingMessage(null);
            setReplyingTo(message);
            return;
          }
          if (selectedAction.kind === 'edit') {
            setReplyingTo(null);
            setEditingMessage(message);
            return;
          }

          Alert.alert('Delete message?', 'This will remove the message from the conversation.', [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Delete',
              style: 'destructive',
              onPress: () => {
                deleteMessage.mutate(
                  { messageId: message.id, conversationId },
                  {
                    onError: err => {
                      toast.error(formatKiloChatError(err, 'Failed to delete message'));
                    },
                  }
                );
              },
            },
          ]);
        }
      );
    },
    [addReaction, bottom, conversationId, currentUserId, deleteMessage, showActionSheetWithOptions]
  );

  useConversationPresence(sandboxId, conversationId);
  useConversationEventSubscription(sandboxId, conversationId);
  const handleActionFailed = useCallback(() => {
    toast.error("Couldn't reach the bot — please try again");
  }, []);
  const handleMessageDeliveryFailed = useCallback(() => {
    toast.error('Message could not be delivered to the bot');
  }, []);
  useMessageCacheUpdater(
    client,
    sandboxId,
    conversationId,
    clearTypingForMember,
    handleActionFailed,
    handleMessageDeliveryFailed
  );

  const activeAndFocused = useAppActiveAndFocused();
  const markRead = useMarkRead(client);
  const markReadStateRef = useRef(createMarkReadState());
  useEffect(() => {
    if (!activeAndFocused) {
      return;
    }
    const marker = `${conversationId}:${latestMessageId ?? 'empty'}`;
    const state = markReadStateRef.current;
    if (!shouldStartMarkReadAttempt(state, marker)) {
      return;
    }
    startMarkReadAttempt(state, marker);
    void (async () => {
      try {
        await markRead(sandboxId, conversationId);
        succeedMarkReadAttempt(state, marker);
      } catch {
        // useMarkRead already surfaces the mutation error to the user.
      } finally {
        finishMarkReadAttempt(state, marker);
      }
    })();
  }, [activeAndFocused, conversationId, latestMessageId, markRead, sandboxId]);

  useFocusEffect(
    useCallback(() => {
      setActiveChatLocation({ sandboxId, conversationId });
      return () => {
        setActiveChatLocation(null);
      };
    }, [sandboxId, conversationId])
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
        <TypingIndicator typingMembers={typingMembers} />
        <MessageInput
          key={editingMessage?.id ?? 'compose'}
          onSend={handleSend}
          onTyping={sendTyping}
          disabled={sendMutation.isPending || editMessage.isPending}
          initialText={editingText}
          replyingTo={replyingTo}
          onCancelReply={
            replyingTo
              ? () => {
                  setReplyingTo(null);
                }
              : undefined
          }
          onCancelEdit={
            editingMessage
              ? () => {
                  setEditingMessage(null);
                }
              : undefined
          }
        />
      </KeyboardAvoidingView>
    </View>
  );
}
