import { type KiloChatClient } from '@kilocode/kilo-chat';
import {
  useMessageCacheUpdater,
  useMessages,
  useSendMessage as useSharedSendMessage,
} from '@kilocode/kilo-chat-hooks';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';

import { formatMobileKiloChatError } from '../kilo-chat-error';

export { useMessages, useMessageCacheUpdater };

export function useSendMessage(
  client: KiloChatClient,
  conversationId: string | null,
  currentUserId: string | null
) {
  return useSharedSendMessage(client, conversationId, currentUserId, {
    onError: err => {
      toast.error(formatMobileKiloChatError(err, i18n.t('chat.messageActions.sendFailed')));
    },
  });
}
