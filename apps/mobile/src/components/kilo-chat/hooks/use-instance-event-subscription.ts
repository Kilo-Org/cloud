import { useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useFocusEffect } from 'expo-router';

import { kiloclawInstanceContext } from '@kilocode/event-service';
import { conversationsKey, registerConversationListCacheHandlers } from '@kilocode/kilo-chat-hooks';

import { useCurrentUserId } from './use-current-user-id';
import { useEventServiceClient, useKiloChatClient } from './use-kilo-chat-client';
import { debugKiloChat } from '../debug';

export function useInstanceEventSubscription(
  sandboxId: string | undefined,
  activeConversationId?: string | null
) {
  const qc = useQueryClient();
  const eventService = useEventServiceClient();
  const kiloChatClient = useKiloChatClient();
  const currentUserId = useCurrentUserId();
  const ctx = sandboxId ? kiloclawInstanceContext(sandboxId) : null;
  const queryKey = useMemo(() => conversationsKey(sandboxId ?? null), [sandboxId]);

  useFocusEffect(
    useCallback(() => {
      if (!ctx) {
        return undefined;
      }
      debugKiloChat('instance event subscribe', {
        context: ctx,
        connected:
          typeof eventService.isConnected === 'function' ? eventService.isConnected() : null,
        hasActiveConversation: activeConversationId !== null && activeConversationId !== undefined,
      });
      eventService.subscribe([ctx]);
      return () => {
        debugKiloChat('instance event unsubscribe', { context: ctx });
        eventService.unsubscribe([ctx]);
      };
    }, [activeConversationId, ctx, eventService])
  );

  useFocusEffect(
    useCallback(() => {
      if (!sandboxId) {
        return undefined;
      }
      return registerConversationListCacheHandlers({
        activeConversationId: activeConversationId ?? null,
        currentUserId,
        eventService,
        kiloChatClient,
        queryClient: qc,
        queryKey,
        sandboxId,
      });
    }, [activeConversationId, currentUserId, eventService, kiloChatClient, qc, queryKey, sandboxId])
  );
}
