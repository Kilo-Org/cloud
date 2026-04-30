import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { kiloclawInstanceContext } from '@kilocode/event-service';
import { botStatusKey, conversationsKey } from '@kilocode/kilo-chat-hooks';

import { useEventSubscription } from './use-event-subscription';

export function useInstanceEventSubscription(sandboxId: string | undefined) {
  const qc = useQueryClient();
  const ctx = sandboxId ? kiloclawInstanceContext(sandboxId) : null;

  // conversation.* events are published on the instance context to keep the
  // conversation list (last-activity, unread, title, membership) current while
  // the user is on the list. message.* events fire on conversation contexts,
  // not here.
  const invalidateConversations = useCallback(() => {
    void qc.invalidateQueries({ queryKey: conversationsKey(sandboxId ?? null) });
  }, [qc, sandboxId]);

  const invalidateBotStatus = useCallback(() => {
    void qc.invalidateQueries({ queryKey: botStatusKey(sandboxId ?? null) });
  }, [qc, sandboxId]);

  useEventSubscription(ctx, 'conversation.created', invalidateConversations);
  useEventSubscription(ctx, 'conversation.left', invalidateConversations);
  useEventSubscription(ctx, 'conversation.renamed', invalidateConversations);
  useEventSubscription(ctx, 'conversation.read', invalidateConversations);
  useEventSubscription(ctx, 'conversation.activity', invalidateConversations);
  useEventSubscription(ctx, 'bot.status', invalidateBotStatus);
}
