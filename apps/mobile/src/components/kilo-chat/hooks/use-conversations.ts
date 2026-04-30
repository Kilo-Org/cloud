import { formatKiloChatError, type KiloChatClient } from '@kilocode/kilo-chat';
import {
  useConversationDetail,
  useConversations,
  useCreateConversation as useSharedCreateConversation,
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
