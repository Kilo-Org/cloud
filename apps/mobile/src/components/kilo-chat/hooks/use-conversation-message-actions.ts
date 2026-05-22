import { useActionSheet } from '@expo/react-native-action-sheet';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import {
  clearPendingAction,
  type PendingAction,
  tryStartPendingAction,
  useAddReaction,
  useDeleteMessage,
  useExecuteAction,
  useRemoveReaction,
} from '@kilocode/kilo-chat-hooks';
import {
  buildMessageActionAvailability,
  contentBlocksToText,
  type ExecApprovalDecision,
  formatKiloChatError,
  type KiloChatClient,
  type Message,
} from '@kilocode/kilo-chat';
import { useCallback, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { toast } from 'sonner-native';

import { executeActionWithMobileFeedback } from '../execute-action-feedback';
import { buildMessageActionSheetOptions, getSelectedMessageAction } from '../message-actions';
import { canCopyMessage, canToggleReaction } from '../message-presentation';

type Params = {
  client: KiloChatClient;
  conversationId: string;
  currentUserId: string | null;
  onEditMessage: (message: Message) => void;
  onReplyToMessage: (message: Message) => void;
};

export function useConversationMessageActions({
  client,
  conversationId,
  currentUserId,
  onEditMessage,
  onReplyToMessage,
}: Params) {
  const { showActionSheetWithOptions } = useActionSheet();
  const { bottom } = useSafeAreaInsets();
  const [reactionPickerMessage, setReactionPickerMessage] = useState<Message | null>(null);
  const [recentReactions, setRecentReactions] = useState<string[]>([]);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const pendingActionRef = useRef<PendingAction | null>(null);
  const deleteMessage = useDeleteMessage(client, conversationId);
  const executeAction = useExecuteAction(client, conversationId, currentUserId);
  const addReaction = useAddReaction(client, conversationId, currentUserId);
  const removeReaction = useRemoveReaction(client, conversationId, currentUserId);

  const handleReactionPress = useCallback(
    (message: Message, emoji: string) => {
      if (!currentUserId || !canToggleReaction(message, currentUserId)) {
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
      setRecentReactions(previous => [emoji, ...previous.filter(reaction => reaction !== emoji)]);
      void Haptics.selectionAsync();
    },
    [addReaction, currentUserId, removeReaction]
  );

  const handleCopyMessage = useCallback(async (message: Message) => {
    try {
      await Clipboard.setStringAsync(contentBlocksToText(message.content));
      toast.success('Copied');
    } catch {
      toast.error('Failed to copy');
    }
  }, []);

  const handleExecuteAction = useCallback(
    (message: Message, groupId: string, value: ExecApprovalDecision) => {
      const nextPendingAction = { messageId: message.id, groupId };
      if (!tryStartPendingAction(pendingActionRef, nextPendingAction)) {
        return;
      }
      setPendingAction(pendingActionRef.current);
      executeActionWithMobileFeedback({
        executeAction,
        message,
        groupId,
        value,
        onSettled: () => {
          clearPendingAction(pendingActionRef, nextPendingAction);
          setPendingAction(pendingActionRef.current);
        },
      });
    },
    [executeAction]
  );

  const handleLongPressMessage = useCallback(
    (message: Message) => {
      const isOwnMessage = currentUserId !== null && message.senderId === currentUserId;
      const actionAvailability = buildMessageActionAvailability(message, isOwnMessage);
      const isPendingMessage = message.id.startsWith('pending-');
      const actionSheet = buildMessageActionSheetOptions({
        canReact: currentUserId !== null && actionAvailability.canReact,
        canReply: actionAvailability.canReply,
        canCopy: canCopyMessage(message),
        canEdit: actionAvailability.canEdit,
        canDelete: actionAvailability.canDelete,
        isPendingMessage,
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
            handleReactionPress(message, selectedAction.emoji);
            return;
          }
          if (selectedAction.kind === 'more-reactions') {
            setReactionPickerMessage(message);
            return;
          }
          if (selectedAction.kind === 'copy') {
            void handleCopyMessage(message);
            return;
          }
          if (selectedAction.kind === 'reply') {
            onReplyToMessage(message);
            return;
          }
          if (selectedAction.kind === 'edit') {
            onEditMessage(message);
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
    [
      bottom,
      conversationId,
      currentUserId,
      deleteMessage,
      handleCopyMessage,
      handleReactionPress,
      onEditMessage,
      onReplyToMessage,
      showActionSheetWithOptions,
    ]
  );

  const handleSwipeReplyMessage = useCallback(
    (message: Message) => {
      const isOwnMessage = currentUserId !== null && message.senderId === currentUserId;
      const actionAvailability = buildMessageActionAvailability(message, isOwnMessage);
      if (!actionAvailability.canReply) {
        return;
      }
      onReplyToMessage(message);
      void Haptics.selectionAsync();
    },
    [currentUserId, onReplyToMessage]
  );

  return {
    handleExecuteAction,
    handleLongPressMessage,
    handleReactionPress,
    handleSwipeReplyMessage,
    pendingAction,
    reactionPickerMessage,
    recentReactions,
    setReactionPickerMessage,
  };
}
