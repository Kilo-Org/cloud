import { useCallback, useRef, useState } from 'react';
import type { TypingEvent } from '../types';
import { useKiloChatClient } from './useKiloChatClient';

const TYPING_COOLDOWN = 3000;
const TYPING_DISPLAY_TIMEOUT = 4000;

/**
 * Sends typing indicator pings (debounced, 3s cooldown).
 */
export function useTypingSender(
  getToken: () => Promise<string>,
  conversationId: string | null,
) {
  const client = useKiloChatClient(getToken);
  const lastSentRef = useRef(0);

  return useCallback(() => {
    if (!conversationId) return;
    const now = Date.now();
    if (now - lastSentRef.current < TYPING_COOLDOWN) return;
    lastSentRef.current = now;
    void client.fetch(`/v1/conversations/${conversationId}/typing`, {
      method: 'POST',
    });
  }, [client, conversationId]);
}

/**
 * Tracks who is typing based on incoming SSE typing events.
 * Clears a member's typing state after 4s of no pings.
 */
export function useTypingState(currentUserId: string | null) {
  const [typingMembers, setTypingMembers] = useState<Map<string, number>>(
    new Map(),
  );
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  const handleTypingEvent = useCallback(
    (event: TypingEvent) => {
      // Don't show own typing
      if (event.memberId === currentUserId) return;

      setTypingMembers((prev) => {
        const next = new Map(prev);
        next.set(event.memberId, Date.now());
        return next;
      });

      // Clear existing timer for this member
      const existing = timersRef.current.get(event.memberId);
      if (existing) clearTimeout(existing);

      // Set new timer to remove typing state
      const timer = setTimeout(() => {
        setTypingMembers((prev) => {
          const next = new Map(prev);
          next.delete(event.memberId);
          return next;
        });
        timersRef.current.delete(event.memberId);
      }, TYPING_DISPLAY_TIMEOUT);
      timersRef.current.set(event.memberId, timer);
    },
    [currentUserId],
  );

  return { typingMembers, handleTypingEvent };
}
