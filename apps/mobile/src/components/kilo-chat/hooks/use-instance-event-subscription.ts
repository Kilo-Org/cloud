import { useCallback, useEffect, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { kiloclawInstanceContext } from '@kilocode/event-service';
import {
  botStatusKey,
  conversationsKey,
  registerConversationListCacheHandlers,
} from '@kilocode/kilo-chat-hooks';

import { useEventSubscription } from './use-event-subscription';
import { useCurrentUserId } from './use-current-user-id';
import { useEventServiceClient, useKiloChatClient } from './use-kilo-chat-client';

export function useInstanceEventSubscription(sandboxId: string | undefined) {
  const qc = useQueryClient();
  const eventService = useEventServiceClient();
  const kiloChatClient = useKiloChatClient();
  const currentUserId = useCurrentUserId();
  const ctx = sandboxId ? kiloclawInstanceContext(sandboxId) : null;
  const queryKey = useMemo(() => conversationsKey(sandboxId ?? null), [sandboxId]);

  const invalidateBotStatus = useCallback(() => {
    void qc.invalidateQueries({ queryKey: botStatusKey(sandboxId ?? null) });
  }, [qc, sandboxId]);

  useEventSubscription(ctx, 'bot.status', invalidateBotStatus);

  useEffect(() => {
    if (!sandboxId) {
      return undefined;
    }
    return registerConversationListCacheHandlers({
      currentUserId,
      eventService,
      kiloChatClient,
      queryClient: qc,
      queryKey,
      sandboxId,
    });
  }, [currentUserId, eventService, kiloChatClient, qc, queryKey, sandboxId]);
}
