import * as Haptics from 'expo-haptics';
import { useEditMessage } from '@kilocode/kilo-chat-hooks';
import {
  buildMessageEditContent,
  contentBlocksToText,
  formatKiloChatError,
  type InputContentBlock,
  type KiloChatClient,
  type Message,
} from '@kilocode/kilo-chat';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner-native';

import { resolveMobileMessageInputAvailability } from '../bot-send-state';
import { type MessageInputSubmitControls } from '../message-input-state';
import {
  buildSendMessageVariables,
  createSendMessageClientId,
  getEditableAttachmentBlocks,
  getVisibleEditableAttachmentBlocks,
} from '../message-presentation';
import { useConversationMessageActions } from './use-conversation-message-actions';
import { useSendMessage } from './use-messages';

type BotPresence = {
  online: boolean;
  lastAt: number;
};

type Params = {
  client: KiloChatClient;
  conversationId: string;
  currentUserId: string | null;
  instanceStatus: string | null;
  now: number;
  presence?: BotPresence;
};

function editableText(message: Message): string {
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n');
}

export function useConversationMessageController({
  client,
  conversationId,
  currentUserId,
  instanceStatus,
  now,
  presence,
}: Params) {
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);
  const [removedEditAttachmentIds, setRemovedEditAttachmentIds] = useState<string[]>([]);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [scrollToNewestRequest, setScrollToNewestRequest] = useState(0);

  const sendMutation = useSendMessage(client, conversationId, currentUserId);
  const editMessage = useEditMessage(client, conversationId);
  const editingTextValue = useMemo(
    () => (editingMessage ? editableText(editingMessage) : ''),
    [editingMessage]
  );
  const editingAttachments = useMemo(
    () => (editingMessage ? getEditableAttachmentBlocks(editingMessage) : []),
    [editingMessage]
  );
  const visibleEditingAttachments = useMemo(
    () => getVisibleEditableAttachmentBlocks(editingAttachments, removedEditAttachmentIds),
    [editingAttachments, removedEditAttachmentIds]
  );
  const inputAvailability = resolveMobileMessageInputAvailability({
    currentUserId,
    instanceStatus,
    presence,
    now,
    pendingMutation: sendMutation.isPending || editMessage.isPending,
    editing: editingMessage !== null,
  });

  const startReplyToMessage = useCallback((message: Message) => {
    setEditingMessage(null);
    setRemovedEditAttachmentIds([]);
    setReplyingTo(message);
  }, []);

  const startEditingMessage = useCallback((message: Message) => {
    setReplyingTo(null);
    setEditingMessage(message);
    setRemovedEditAttachmentIds([]);
  }, []);

  const messageActions = useConversationMessageActions({
    client,
    conversationId,
    currentUserId,
    onEditMessage: startEditingMessage,
    onReplyToMessage: startReplyToMessage,
  });

  const handleSend = useCallback(
    (
      content: InputContentBlock[],
      inReplyToMessageId?: string,
      controls?: MessageInputSubmitControls
    ) => {
      if (!editingMessage && inputAvailability.disabled) {
        return;
      }
      if (editingMessage) {
        const editContent = buildMessageEditContent({
          text: contentBlocksToText(content),
          originalAttachments: editingAttachments,
          removedAttachmentIds: removedEditAttachmentIds,
        });
        editMessage.mutate(
          {
            messageId: editingMessage.id,
            conversationId,
            content: editContent,
            timestamp: Date.now(),
          },
          {
            onSuccess: () => {
              controls?.clearDraft();
              setEditingMessage(null);
              setRemovedEditAttachmentIds([]);
              void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
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
          content,
          clientId: createSendMessageClientId(),
          inReplyToMessageId,
        }),
        {
          onSuccess: () => {
            if (controls?.clearDraft() ?? false) {
              setReplyingTo(null);
            }
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          },
          onError: err => {
            toast.error(formatKiloChatError(err, 'Failed to send message'));
          },
        }
      );
      setScrollToNewestRequest(request => request + 1);
    },
    [
      conversationId,
      editMessage,
      editingAttachments,
      editingMessage,
      inputAvailability.disabled,
      removedEditAttachmentIds,
      sendMutation,
    ]
  );

  const handleRemoveEditableAttachment = useCallback((attachmentId: string) => {
    setRemovedEditAttachmentIds(current =>
      current.includes(attachmentId) ? current : [...current, attachmentId]
    );
  }, []);

  return {
    editingMessage,
    editingText: editingTextValue,
    handleExecuteAction: messageActions.handleExecuteAction,
    handleLongPressMessage: messageActions.handleLongPressMessage,
    handleReactionPress: messageActions.handleReactionPress,
    handleRemoveEditableAttachment,
    handleSend,
    handleSwipeReplyMessage: messageActions.handleSwipeReplyMessage,
    inputAvailability,
    pendingAction: messageActions.pendingAction,
    reactionPickerMessage: messageActions.reactionPickerMessage,
    recentReactions: messageActions.recentReactions,
    replyingTo,
    scrollToNewestRequest,
    setEditingMessage,
    setReactionPickerMessage: messageActions.setReactionPickerMessage,
    setRemovedEditAttachmentIds,
    setReplyingTo,
    visibleEditingAttachments,
  };
}
