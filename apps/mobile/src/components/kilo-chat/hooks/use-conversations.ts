import { formatKiloChatError, type KiloChatClient } from '@kilocode/kilo-chat';
import {
  useConversationDetail,
  useConversations,
  useCreateConversation as useSharedCreateConversation,
  useLeaveConversation as useSharedLeaveConversation,
  useRenameConversation as useSharedRenameConversation,
} from '@kilocode/kilo-chat-hooks';
import { toast } from 'sonner-native';

export { useConversations, useConversationDetail };

export function useCreateConversation(client: KiloChatClient) {
  return useSharedCreateConversation(client, {
    onError: err => {
      toast.error(formatKiloChatError(err, 'Failed to create conversation'));
    },
  });
}

export function useRenameConversation(client: KiloChatClient) {
  return useSharedRenameConversation(client, {
    onError: err => {
      toast.error(formatKiloChatError(err, 'Failed to rename conversation'));
    },
  });
}

export function useLeaveConversation(client: KiloChatClient) {
  return useSharedLeaveConversation(client, {
    onError: err => {
      toast.error(formatKiloChatError(err, 'Failed to leave conversation'));
    },
  });
}
