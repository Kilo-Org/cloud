import { useCallback, useEffect, useRef, useState } from 'react';
import type { KiloChatClient } from '@kilocode/kilo-chat';
import type { TypingEvent } from '@kilocode/kilo-chat';

const TYPING_COOLDOWN = 3000;
const TYPING_DISPLAY_TIMEOUT = 5000;

/**
 * Sends typing indicator pings (debounced, 3s cooldown).
 */
export function useTypingSender(client: KiloChatClient, conversationId: string | null) {
  const lastSentRef = useRef(0);
  return useCallback(() => {
    if (!conversationId) return;
    const now = Date.now();
    if (now - lastSentRef.current < TYPING_COOLDOWN) return;
    lastSentRef.current = now;
    // Typing is best-effort; a failed ping (offline, 5xx, etc.) is noise, not
    // an error worth surfacing. Explicitly swallow so the floating promise
    // doesn't bubble up to the browser's unhandledrejection handler.
    client.sendTyping(conversationId).catch(() => {});
  }, [client, conversationId]);
}

/**
 * Tracks who is typing based on incoming typing events.
 * Clears a member's typing state after 5s of no pings.
 *
 * Both handlers receive the Event Service context string and ignore events
 * that do not match `expectedContext`, so leaked or stale subscriptions
 * cannot update typing state for the wrong conversation.
 */
export function useTypingState(currentUserId: string | null, expectedContext: string | null) {
  const [typingMembers, setTypingMembers] = useState<Map<string, number>>(new Map());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const handleTypingEvent = useCallback(
    (ctx: string, event: TypingEvent) => {
      if (ctx !== expectedContext) return;
      if (event.memberId === currentUserId) return;
      setTypingMembers(prev => {
        const next = new Map(prev);
        next.set(event.memberId, Date.now());
        return next;
      });
      const existing = timersRef.current.get(event.memberId);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        setTypingMembers(prev => {
          const next = new Map(prev);
          next.delete(event.memberId);
          return next;
        });
        timersRef.current.delete(event.memberId);
      }, TYPING_DISPLAY_TIMEOUT);
      timersRef.current.set(event.memberId, timer);
    },
    [currentUserId, expectedContext]
  );
  const clearTypingForMember = useCallback(
    (ctx: string, memberId: string) => {
      if (ctx !== expectedContext) return;
      const existing = timersRef.current.get(memberId);
      if (existing) {
        clearTimeout(existing);
        timersRef.current.delete(memberId);
      }
      setTypingMembers(prev => {
        if (!prev.has(memberId)) return prev;
        const next = new Map(prev);
        next.delete(memberId);
        return next;
      });
    },
    [expectedContext]
  );

  // Clear all pending timers on unmount
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, []);

  return { typingMembers, handleTypingEvent, clearTypingForMember };
}
