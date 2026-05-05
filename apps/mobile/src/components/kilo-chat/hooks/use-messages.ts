import { formatKiloChatError, type KiloChatClient } from '@kilocode/kilo-chat';
import {
  useMessageCacheUpdater,
  useMessages,
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
