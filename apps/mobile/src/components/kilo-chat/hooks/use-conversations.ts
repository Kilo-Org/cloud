import { formatKiloChatError, type KiloChatClient } from '@kilocode/kilo-chat';
import {
  useConversationDetail,
  useConversations,
  useCreateConversation as useSharedCreateConversation,
  useLeaveConversation as useSharedLeaveConversation,
  useRenameConversation as useSharedRenameConversation,
} from '@kilocode/kilo-chat-hooks';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';

export { useConversations, useConversationDetail };

export function useCreateConversation(client: KiloChatClient) {
  return useSharedCreateConversation(client, {
    onError: err => {
      toast.error(formatKiloChatError(err, i18n.t('chat.conversation.createFailed')));
    },
  });
}

export function useRenameConversation(client: KiloChatClient) {
  // No centralized toast here — callers rename via RenameModal, which stays
  // open on failure and shows the error inline.
  return useSharedRenameConversation(client);
}

export function useLeaveConversation(client: KiloChatClient) {
  return useSharedLeaveConversation(client, {
    onError: err => {
      toast.error(formatKiloChatError(err, i18n.t('chat.conversation.leaveFailed')));
    },
  });
}
