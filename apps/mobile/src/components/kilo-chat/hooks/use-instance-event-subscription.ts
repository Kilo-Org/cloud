import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { botStatusKey, useConversationListEventUpdater } from '@kilocode/kilo-chat-hooks';

import { useCurrentUserId } from './use-current-user-id';
import { useEventServiceClient, useKiloChatClient } from './use-kilo-chat-client';

export function useInstanceEventSubscription(sandboxId: string | undefined) {
  const qc = useQueryClient();
  const eventService = useEventServiceClient();
  const kiloChatClient = useKiloChatClient();
  const currentUserId = useCurrentUserId();

  const invalidateBotStatus = useCallback(() => {
    void qc.invalidateQueries({ queryKey: botStatusKey(sandboxId ?? null) });
  }, [qc, sandboxId]);

  useConversationListEventUpdater(kiloChatClient, eventService, sandboxId, currentUserId, {
    onBotStatus: invalidateBotStatus,
  });
}
