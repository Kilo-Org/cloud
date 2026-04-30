import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { kiloclawConversationContext } from '@kilocode/event-service';
import { type KiloChatClient } from '@kilocode/kilo-chat';

import {
  applyTypingEventToMembers,
  type TypingEventKind,
  typingIndicatorLabel,
} from './typing-indicator-state';
import { useAppActiveAndFocused } from './use-app-active-and-focused';

const TYPING_STALE_MS = 5000;

type UseTypingIndicatorInput = {
  client: KiloChatClient;
  sandboxId: string;
  conversationId: string;
  currentUserId: string | null;
};

export function useTypingIndicator({
  client,
  sandboxId,
  conversationId,
  currentUserId,
}: UseTypingIndicatorInput) {
  const activeAndFocused = useAppActiveAndFocused();
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const timeoutsRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const expectedContext = useMemo(
    () => kiloclawConversationContext(sandboxId, conversationId),
    [conversationId, sandboxId]
  );

  const clearMemberTimeout = useCallback((memberId: string) => {
    const timeout = timeoutsRef.current.get(memberId);
    if (timeout) {
      clearTimeout(timeout);
      timeoutsRef.current.delete(memberId);
    }
  }, []);

  const removeMember = useCallback(
    (memberId: string) => {
      clearMemberTimeout(memberId);
      setMemberIds(current => current.filter(id => id !== memberId));
    },
    [clearMemberTimeout]
  );

  const applyEvent = useCallback(
    (event: TypingEventKind, eventContext: string, memberId: string) => {
      setMemberIds(current =>
        applyTypingEventToMembers(current, {
          event,
          expectedContext,
          eventContext,
          memberId,
          currentUserId,
        })
      );

      if (eventContext !== expectedContext || memberId === currentUserId) {
        return;
      }

      if (event === 'typing.stop') {
        clearMemberTimeout(memberId);
        return;
      }

      clearMemberTimeout(memberId);
      const timeout = setTimeout(() => {
        removeMember(memberId);
      }, TYPING_STALE_MS);
      timeoutsRef.current.set(memberId, timeout);
    },
    [clearMemberTimeout, currentUserId, expectedContext, removeMember]
  );

  useEffect(() => {
    const timeouts = timeoutsRef.current;
    if (!activeAndFocused) {
      for (const timeout of timeouts.values()) {
        clearTimeout(timeout);
      }
      timeouts.clear();
      setMemberIds([]);
      return undefined;
    }

    const offTyping = client.onTyping((eventContext, event) => {
      applyEvent('typing', eventContext, event.memberId);
    });
    const offTypingStop = client.onTypingStop((eventContext, event) => {
      applyEvent('typing.stop', eventContext, event.memberId);
    });

    return () => {
      offTyping();
      offTypingStop();
      for (const timeout of timeouts.values()) {
        clearTimeout(timeout);
      }
      timeouts.clear();
    };
  }, [activeAndFocused, applyEvent, client]);

  return {
    isTyping: memberIds.length > 0,
    name: typingIndicatorLabel(memberIds),
  };
}
