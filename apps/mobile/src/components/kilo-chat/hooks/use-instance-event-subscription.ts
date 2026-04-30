import { useCallback, useEffect, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { kiloclawInstanceContext } from '@kilocode/event-service';
import {
  conversationActivityEventSchema,
  conversationCreatedEventSchema,
  conversationLeftEventSchema,
  conversationReadEventSchema,
  conversationRenamedEventSchema,
} from '@kilocode/kilo-chat';
import {
  botStatusKey,
  conversationKey,
  type ConversationListInfiniteData,
  conversationsKey,
  filterConversationPages,
  updateConversationPages,
} from '@kilocode/kilo-chat-hooks';

import { isConversationOnFirstPage, shouldApplyConversationRead } from './instance-event-cache';
import { useEventSubscription } from './use-event-subscription';
import { useCurrentUserId } from './use-current-user-id';
import { useEventServiceClient } from './use-kilo-chat-client';

export function useInstanceEventSubscription(sandboxId: string | undefined) {
  const qc = useQueryClient();
  const eventService = useEventServiceClient();
  const currentUserId = useCurrentUserId();
  const ctx = sandboxId ? kiloclawInstanceContext(sandboxId) : null;
  const queryKey = useMemo(() => conversationsKey(sandboxId ?? null), [sandboxId]);

  // conversation.* events are published on the instance context to keep the
  // conversation list (last-activity, unread, title, membership) current while
  // the user is on the list. message.* events fire on conversation contexts,
  // not here.
  const handleCreated = useCallback(
    (payload: unknown) => {
      const result = conversationCreatedEventSchema.safeParse(payload);
      if (!result.success) {
        return;
      }
      const event = result.data;
      const data = qc.getQueryData<ConversationListInfiniteData>(queryKey);
      if (isConversationOnFirstPage(data, event.conversationId)) {
        return;
      }
      void qc.invalidateQueries({ queryKey });
    },
    [qc, queryKey]
  );

  const handleLeft = useCallback(
    (payload: unknown) => {
      const result = conversationLeftEventSchema.safeParse(payload);
      if (!result.success) {
        return;
      }
      const event = result.data;
      qc.setQueryData<ConversationListInfiniteData>(queryKey, old =>
        filterConversationPages(
          old,
          conversation => conversation.conversationId !== event.conversationId
        )
      );
    },
    [qc, queryKey]
  );

  const handleRenamed = useCallback(
    (payload: unknown) => {
      const result = conversationRenamedEventSchema.safeParse(payload);
      if (!result.success) {
        return;
      }
      const event = result.data;
      qc.setQueryData<ConversationListInfiniteData>(queryKey, old =>
        updateConversationPages(old, conversation =>
          conversation.conversationId === event.conversationId
            ? { ...conversation, title: event.title }
            : conversation
        )
      );
      void qc.invalidateQueries({ queryKey: conversationKey(event.conversationId) });
    },
    [qc, queryKey]
  );

  const handleRead = useCallback(
    (payload: unknown) => {
      const result = conversationReadEventSchema.safeParse(payload);
      if (!result.success) {
        return;
      }
      const event = result.data;
      if (!shouldApplyConversationRead(currentUserId, event.memberId)) {
        return;
      }
      qc.setQueryData<ConversationListInfiniteData>(queryKey, old =>
        updateConversationPages(old, conversation =>
          conversation.conversationId === event.conversationId
            ? { ...conversation, lastReadAt: event.lastReadAt }
            : conversation
        )
      );
    },
    [currentUserId, qc, queryKey]
  );

  const handleActivity = useCallback(
    (payload: unknown) => {
      const result = conversationActivityEventSchema.safeParse(payload);
      if (!result.success) {
        return;
      }
      const event = result.data;
      const data = qc.getQueryData<ConversationListInfiniteData>(queryKey);
      if (!isConversationOnFirstPage(data, event.conversationId)) {
        void qc.invalidateQueries({ queryKey });
        return;
      }
      qc.setQueryData<ConversationListInfiniteData>(queryKey, old =>
        updateConversationPages(old, conversation =>
          conversation.conversationId === event.conversationId
            ? { ...conversation, lastActivityAt: event.lastActivityAt }
            : conversation
        )
      );
    },
    [qc, queryKey]
  );

  const invalidateBotStatus = useCallback(() => {
    void qc.invalidateQueries({ queryKey: botStatusKey(sandboxId ?? null) });
  }, [qc, sandboxId]);

  useEventSubscription(ctx, 'conversation.created', handleCreated);
  useEventSubscription(ctx, 'conversation.left', handleLeft);
  useEventSubscription(ctx, 'conversation.renamed', handleRenamed);
  useEventSubscription(ctx, 'conversation.read', handleRead);
  useEventSubscription(ctx, 'conversation.activity', handleActivity);
  useEventSubscription(ctx, 'bot.status', invalidateBotStatus);

  useEffect(() => {
    if (!sandboxId) {
      return undefined;
    }
    return eventService.onReconnect(() => {
      void qc.invalidateQueries({ queryKey });
    });
  }, [eventService, qc, queryKey, sandboxId]);
}
