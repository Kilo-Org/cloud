import { useEffect, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { kiloclawInstanceContext } from '@kilocode/event-service';
import { conversationsKey, registerConversationListCacheHandlers } from '@kilocode/kilo-chat-hooks';

import { useCurrentUserId } from './use-current-user-id';
import { useEventServiceClient, useKiloChatClient } from './use-kilo-chat-client';

export function useInstanceEventSubscription(sandboxId: string | undefined) {
  const qc = useQueryClient();
  const eventService = useEventServiceClient();
  const kiloChatClient = useKiloChatClient();
  const currentUserId = useCurrentUserId();
  const ctx = sandboxId ? kiloclawInstanceContext(sandboxId) : null;
  const queryKey = useMemo(() => conversationsKey(sandboxId ?? null), [sandboxId]);

  useEffect(() => {
    if (!ctx) {
      return undefined;
    }
    eventService.subscribe([ctx]);
    return () => {
      eventService.unsubscribe([ctx]);
    };
  }, [ctx, eventService]);

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
