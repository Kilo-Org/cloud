import { formatKiloChatError, type KiloChatClient } from '@kilocode/kilo-chat';
import {
  useAddReaction as useSharedAddReaction,
  useExecuteAction as useSharedExecuteAction,
  useMessageCacheUpdater,
  useMessages,
  useRemoveReaction as useSharedRemoveReaction,
  useSendMessage as useSharedSendMessage,
} from '@kilocode/kilo-chat-hooks';
import { toast } from 'sonner-native';

export { useMessages, useMessageCacheUpdater };

export function useSendMessage(
  client: KiloChatClient,
  conversationId: string | null,
  currentUserId: string | null
) {
  return useSharedSendMessage(client, conversationId, currentUserId, {
    onError: err => {
      toast.error(formatKiloChatError(err, 'Failed to send message'));
    },
  });
}

export function useAddReaction(
  client: KiloChatClient,
  conversationId: string | null,
  currentUserId: string | null
) {
  return useSharedAddReaction(client, conversationId, currentUserId, {
    onError: err => {
      toast.error(formatKiloChatError(err, 'Failed to add reaction'));
    },
  });
}

export function useRemoveReaction(
  client: KiloChatClient,
  conversationId: string | null,
  currentUserId: string | null
) {
  return useSharedRemoveReaction(client, conversationId, currentUserId, {
    onError: err => {
      toast.error(formatKiloChatError(err, 'Failed to remove reaction'));
    },
  });
}

export function useExecuteAction(
  client: KiloChatClient,
  conversationId: string | null,
  currentUserId: string | null
) {
  return useSharedExecuteAction(client, conversationId, currentUserId, {
    onError: err => {
      toast.error(formatKiloChatError(err, 'Failed to execute action'));
    },
  });
}
