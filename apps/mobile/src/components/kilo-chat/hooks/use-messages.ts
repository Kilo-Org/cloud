import { formatKiloChatError, type KiloChatClient } from '@kilocode/kilo-chat';
import {
  useMessageCacheUpdater,
  useMessages,
  useAddReaction as useSharedAddReaction,
  useDeleteMessage as useSharedDeleteMessage,
  useEditMessage as useSharedEditMessage,
  useExecuteAction as useSharedExecuteAction,
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

export function useEditMessage(client: KiloChatClient, conversationId: string | null) {
  return useSharedEditMessage(client, conversationId, {
    onError: err => {
      toast.error(formatKiloChatError(err, 'Failed to edit message'));
    },
  });
}

export function useDeleteMessage(client: KiloChatClient, conversationId: string | null) {
  return useSharedDeleteMessage(client, conversationId, {
    onError: err => {
      toast.error(formatKiloChatError(err, 'Failed to delete message'));
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
