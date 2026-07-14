import { useBotStatus, useEventServiceClient } from '@kilocode/kilo-chat-hooks';
import { CONVERSATION_TITLE_MAX_CHARS, type ConversationDetailResponse } from '@kilocode/kilo-chat';
import { useCallback } from 'react';
import { View } from 'react-native';
import { type Href, useFocusEffect, useRouter } from 'expo-router';
import { toast } from 'sonner-native';

import { RenameModal } from '@/components/rename-modal';

import { AppAwareKeyboardPaddingView } from './app-aware-keyboard-padding';
import { ConversationHeader } from './conversation-header';
import {
  ConversationHistoryErrorView,
  ConversationHistoryLoadingView,
  ConversationInlineRetryBanner,
} from './conversation-history-state-views';
import { MessageInput } from './message-input';
import { MessageList } from './message-list';
import { MessageReactionPickerSheet } from './message-reaction-picker-sheet';
import { getMessageHistoryContentState } from './message-history-state';
import { useConversationPresence } from './hooks/use-conversation-presence';
import { useConversationEventSubscription } from './hooks/use-conversation-event-subscription';
import { useConversationOptionsSheet } from './hooks/use-conversation-options-sheet';
import { useMobileTypingState, useTypingSender } from './hooks/use-typing';
import { useKiloChatClient } from './hooks/use-kilo-chat-client';
import { useConversationMarkRead } from './hooks/use-conversation-mark-read';
import { useConversationMessageController } from './hooks/use-conversation-message-controller';
import { useMessageCacheUpdater, useMessages } from './hooks/use-messages';
import { useNowTicker } from './hooks/use-now-ticker';
import { useCurrentUserId } from './hooks/use-current-user-id';
import { useKiloChatTokenError } from './kilo-chat-provider';
import {
  instanceOrgId,
  useAllKiloClawInstances,
  useInstanceContext,
} from '@/lib/hooks/use-instance-context';
import { useKiloClawStatus } from '@/lib/hooks/use-kiloclaw-queries';
import { kiloclawConversationEyebrow } from '@/lib/kiloclaw-display';
import { chatInstancePickerPath } from '@/lib/kilo-chat-routes';
import { setActiveChatLocation } from '@/lib/notifications';

type Props = {
  sandboxId: string;
  conversationId: string;
  conversationTitle: string;
  conversationRenameTitle: string;
  conversationMembers: ConversationDetailResponse['members'];
};

export function ConversationScreen({
  sandboxId,
  conversationId,
  conversationTitle,
  conversationRenameTitle,
  conversationMembers,
}: Props) {
  const client = useKiloChatClient();
  const eventClient = useEventServiceClient();
  const router = useRouter();
  const currentUserId = useCurrentUserId();
  const tokenError = useKiloChatTokenError();
  const instanceContext = useInstanceContext(sandboxId);
  const instanceStatusQuery = useKiloClawStatus(
    instanceOrgId(instanceContext),
    instanceContext.status === 'ready'
  );
  const { data: instances } = useAllKiloClawInstances();
  const currentInstance = instances?.find(instance => instance.sandboxId === sandboxId);
  const instanceStatus = instanceStatusQuery.data?.status ?? currentInstance?.status ?? null;
  const botStatus = useBotStatus(client, eventClient, sandboxId);
  const botPresence = botStatus ? { online: botStatus.online, lastAt: botStatus.at } : undefined;
  const hasAttachmentsCapability = botStatus?.capabilities?.includes('attachments') ?? false;
  const now = useNowTicker(10_000);

  const messagesQuery = useMessages(client, conversationId);
  const messageHistoryState = getMessageHistoryContentState({
    isPending: messagesQuery.isPending,
    isError: messagesQuery.isError,
    hasData: messagesQuery.data !== undefined,
  });
  const hasInitialMessages =
    messageHistoryState === 'ready' || messageHistoryState === 'stale-error';
  const messages = hasInitialMessages ? (messagesQuery.data?.messages ?? []) : [];
  const fetchOlder = useCallback(() => {
    if (messagesQuery.hasNextPage && !messagesQuery.isFetchingNextPage) {
      void messagesQuery.fetchNextPage();
    }
  }, [messagesQuery]);

  const { openOptions, renaming, closeRename, saveRename } = useConversationOptionsSheet({
    client,
    conversationId,
    sandboxId,
    conversationTitle,
  });
  const { typingMembers, clearTypingForMember } = useMobileTypingState({
    client,
    currentUserId,
    sandboxId,
    conversationId,
  });
  const sendTyping = useTypingSender(client, conversationId);
  const messageController = useConversationMessageController({
    client,
    conversationId,
    currentUserId,
    instanceStatus,
    presence: botPresence,
    now,
  });

  const canSwitchInstance = (instances?.length ?? 0) > 1;
  const instanceLabel = kiloclawConversationEyebrow(currentInstance);

  const handleSwitchInstance = useCallback(() => {
    router.push(chatInstancePickerPath(sandboxId));
  }, [router, sandboxId]);

  const handleOpenInstance = useCallback(() => {
    router.push(`/(app)/kiloclaw/${sandboxId}/dashboard` as Href);
  }, [router, sandboxId]);

  useConversationPresence(sandboxId, conversationId);
  useConversationEventSubscription(sandboxId, conversationId);
  const handleActionFailed = useCallback(() => {
    toast.error("Couldn't reach the bot. Please try again.");
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
  useConversationMarkRead({
    client,
    conversationId,
    currentUserId,
    hasInitialMessages,
    messages,
    sandboxId,
  });

  useFocusEffect(
    useCallback(() => {
      setActiveChatLocation({ sandboxId, conversationId });
      return () => {
        setActiveChatLocation(null);
      };
    }, [sandboxId, conversationId])
  );

  if (messageHistoryState === 'loading') {
    return <ConversationHistoryLoadingView title={conversationTitle} subtitle={instanceLabel} />;
  }

  if (messageHistoryState === 'error') {
    return (
      <ConversationHistoryErrorView
        title={conversationTitle}
        subtitle={instanceLabel}
        onRetry={() => {
          void messagesQuery.refetch();
        }}
      />
    );
  }

  return (
    <View className="flex-1">
      <ConversationHeader
        title={conversationTitle}
        subtitle={instanceLabel}
        canSwitchInstance={canSwitchInstance}
        onSwitchInstance={handleSwitchInstance}
        onOpenOptions={openOptions}
      />
      {tokenError.hasError ? (
        <ConversationInlineRetryBanner
          message="Couldn't sign in to chat"
          onRetry={() => {
            tokenError.retry();
          }}
        />
      ) : null}
      {messageHistoryState === 'stale-error' ? (
        <ConversationInlineRetryBanner
          message="Couldn't refresh messages"
          onRetry={() => {
            void messagesQuery.refetch();
          }}
        />
      ) : null}
      <AppAwareKeyboardPaddingView className="flex-1">
        <MessageList
          client={client}
          conversationId={conversationId}
          messages={messages}
          currentUserId={currentUserId}
          members={conversationMembers}
          botName={instanceLabel}
          fetchOlder={fetchOlder}
          isFetchingOlder={messagesQuery.isFetchingNextPage}
          pendingAction={messageController.pendingAction}
          scrollToNewestRequest={messageController.scrollToNewestRequest}
          onExecuteAction={messageController.handleExecuteAction}
          onLongPressMessage={messageController.handleLongPressMessage}
          onSwipeReplyMessage={messageController.handleSwipeReplyMessage}
          onReactionPress={messageController.handleReactionPress}
        />
        <MessageInput
          key={messageController.editingMessage?.id ?? 'compose'}
          onSend={messageController.handleSend}
          onTyping={sendTyping}
          client={client}
          conversationId={conversationId}
          hasAttachmentsCapability={hasAttachmentsCapability}
          disabled={messageController.inputAvailability.disabled}
          submitDisabled={messageController.inputAvailability.submitDisabled}
          disabledReason={messageController.inputAvailability.disabledReason}
          showInstanceCta={messageController.inputAvailability.showInstanceCta}
          onOpenInstance={handleOpenInstance}
          initialText={messageController.editingText}
          isEditing={messageController.editingMessage !== null}
          editableAttachments={messageController.visibleEditingAttachments}
          onRemoveEditableAttachment={messageController.handleRemoveEditableAttachment}
          botName={instanceLabel}
          typingMembers={typingMembers}
          replyingTo={messageController.replyingTo}
          onCancelReply={
            messageController.replyingTo
              ? () => {
                  messageController.setReplyingTo(null);
                }
              : undefined
          }
          onCancelEdit={
            messageController.editingMessage
              ? () => {
                  messageController.setEditingMessage(null);
                  messageController.setRemovedEditAttachmentIds([]);
                }
              : undefined
          }
        />
      </AppAwareKeyboardPaddingView>
      <MessageReactionPickerSheet
        visible={messageController.reactionPickerMessage !== null}
        recentReactions={messageController.recentReactions}
        onClose={() => {
          messageController.setReactionPickerMessage(null);
        }}
        onSelect={emoji => {
          const message = messageController.reactionPickerMessage;
          if (message) {
            messageController.handleReactionPress(message, emoji);
          }
          messageController.setReactionPickerMessage(null);
        }}
      />
      {renaming && (
        <RenameModal
          title="Rename conversation"
          placeholder="Enter a new name"
          initialValue={conversationRenameTitle}
          maxLength={CONVERSATION_TITLE_MAX_CHARS}
          onSave={saveRename}
          onClose={closeRename}
        />
      )}
    </View>
  );
}
