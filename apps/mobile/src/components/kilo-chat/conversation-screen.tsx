import { useActionSheet } from '@expo/react-native-action-sheet';
import * as Haptics from 'expo-haptics';
import { useBotStatus, useEventServiceClient } from '@kilocode/kilo-chat-hooks';
import { type ConversationDetailResponse } from '@kilocode/kilo-chat';
import { useCallback } from 'react';
import { Alert, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { toast } from 'sonner-native';

import { AppAwareKeyboardPaddingView } from './app-aware-keyboard-padding';
import { ConversationHeader } from './conversation-header';
import {
  ConversationHistoryErrorView,
  ConversationHistoryLoadingView,
} from './conversation-history-state-views';
import { MessageInput } from './message-input';
import { MessageList } from './message-list';
import { MessageReactionPickerSheet } from './message-reaction-picker-sheet';
import { getMessageHistoryContentState } from './message-history-state';
import { useConversationPresence } from './hooks/use-conversation-presence';
import { useConversationEventSubscription } from './hooks/use-conversation-event-subscription';
import { useLeaveConversation } from './hooks/use-conversations';
import { useMobileTypingState, useTypingSender } from './hooks/use-typing';
import { useKiloChatClient } from './hooks/use-kilo-chat-client';
import { useConversationMarkRead } from './hooks/use-conversation-mark-read';
import { useConversationMessageController } from './hooks/use-conversation-message-controller';
import { useMessageCacheUpdater, useMessages } from './hooks/use-messages';
import { useNowTicker } from './hooks/use-now-ticker';
import { useCurrentUserId } from './hooks/use-current-user-id';
import { useAllKiloClawInstances, useInstanceContext } from '@/lib/hooks/use-instance-context';
import { useKiloClawStatus } from '@/lib/hooks/use-kiloclaw-queries';
import { kiloclawConversationEyebrow } from '@/lib/kiloclaw-display';
import {
  chatInstancePickerPath,
  chatRenameConversationPath,
  chatSandboxPath,
} from '@/lib/kilo-chat-routes';
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
  const { showActionSheetWithOptions } = useActionSheet();
  const { bottom } = useSafeAreaInsets();
  const instanceContext = useInstanceContext(sandboxId);
  const instanceStatusQuery = useKiloClawStatus(
    instanceContext.organizationId,
    instanceContext.isResolved
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
  const hasInitialMessages = messageHistoryState === 'ready';
  const messages = hasInitialMessages ? (messagesQuery.data?.messages ?? []) : [];
  const fetchOlder = useCallback(() => {
    if (messagesQuery.hasNextPage && !messagesQuery.isFetchingNextPage) {
      void messagesQuery.fetchNextPage();
    }
  }, [messagesQuery]);

  const leaveConversation = useLeaveConversation(client);
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

  const handleOpenConversationOptions = useCallback(() => {
    void Haptics.selectionAsync();
    showActionSheetWithOptions(
      {
        title: conversationTitle,
        options: ['Rename', 'Leave', 'Cancel'],
        cancelButtonIndex: 2,
        destructiveButtonIndex: 1,
        containerStyle: { paddingBottom: bottom },
      },
      index => {
        if (index === 0) {
          const params = new URLSearchParams({ conversationId, title: conversationRenameTitle });
          router.push(chatRenameConversationPath(sandboxId, params));
          return;
        }
        if (index === 1) {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          Alert.alert('Leave conversation?', 'This removes it from your list.', [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Leave',
              style: 'destructive',
              onPress: () => {
                leaveConversation.mutate(
                  { conversationId, sandboxId },
                  {
                    onSuccess: () => {
                      router.replace(chatSandboxPath(sandboxId));
                    },
                  }
                );
              },
            },
          ]);
        }
      }
    );
  }, [
    bottom,
    conversationId,
    conversationRenameTitle,
    conversationTitle,
    leaveConversation,
    router,
    sandboxId,
    showActionSheetWithOptions,
  ]);
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
        onOpenOptions={handleOpenConversationOptions}
      />
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
    </View>
  );
}
