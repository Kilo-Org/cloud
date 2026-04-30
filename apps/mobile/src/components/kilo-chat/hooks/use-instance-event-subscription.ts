import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { kiloclawInstanceContext } from '@kilocode/event-service';
import { botStatusKey, conversationsKey } from '@kilocode/kilo-chat-hooks';

import { useEventSubscription } from './use-event-subscription';

export function useInstanceEventSubscription(sandboxId: string | undefined) {
  const qc = useQueryClient();
  const ctx = sandboxId ? kiloclawInstanceContext(sandboxId) : null;

  // message.* / conversation.* invalidate the conversations list so
  // last-message preview and unread counts stay current while the user is on
  // the list (instance-level presence, not viewing a specific conv).
  const invalidateConversations = useCallback(() => {
    void qc.invalidateQueries({ queryKey: conversationsKey(sandboxId ?? null) });
  }, [qc, sandboxId]);

  const invalidateBotStatus = useCallback(() => {
    void qc.invalidateQueries({ queryKey: botStatusKey(sandboxId ?? null) });
  }, [qc, sandboxId]);

  useEventSubscription(ctx, 'conversation.created', invalidateConversations);
  useEventSubscription(ctx, 'conversation.left', invalidateConversations);
  useEventSubscription(ctx, 'message.created', invalidateConversations);
  useEventSubscription(ctx, 'message.updated', invalidateConversations);
  useEventSubscription(ctx, 'message.deleted', invalidateConversations);
  useEventSubscription(ctx, 'bot.status', invalidateBotStatus);
}
