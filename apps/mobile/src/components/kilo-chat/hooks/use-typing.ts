import { kiloclawConversationContext } from '@kilocode/event-service';
import { type KiloChatClient, type TypingEvent } from '@kilocode/kilo-chat';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const TYPING_COOLDOWN_MS = 3000;
const TYPING_DISPLAY_TIMEOUT_MS = 5000;

type TypingSenderClient = {
  sendTyping(conversationId: string): Promise<void>;
};

export function applyTypingStarted(
  typingMembers: Map<string, number>,
  {
    ctx,
    event,
    currentUserId,
    expectedContext,
    now,
  }: {
    ctx: string;
    event: TypingEvent;
    currentUserId: string | null;
    expectedContext: string | null;
    now: number;
  }
) {
  if (!expectedContext || ctx !== expectedContext) {
    return typingMembers;
  }
  if (event.memberId === currentUserId) {
    return typingMembers;
  }

  return new Map([...typingMembers, [event.memberId, now]]);
}

export function applyTypingStopped(
  typingMembers: Map<string, number>,
  {
    ctx,
    memberId,
    expectedContext,
  }: {
    ctx: string;
    memberId: string;
    expectedContext: string | null;
  }
) {
  if (!expectedContext || ctx !== expectedContext) {
    return typingMembers;
  }
  if (!typingMembers.has(memberId)) {
    return typingMembers;
  }

  const next = new Map(typingMembers);
  next.delete(memberId);
  return next;
}

export function pruneStaleTypingMembers(
  typingMembers: Map<string, number>,
  now: number,
  timeoutMs = TYPING_DISPLAY_TIMEOUT_MS
) {
  const next = new Map<string, number>();
  for (const [memberId, lastSeenAt] of typingMembers) {
    if (now - lastSeenAt < timeoutMs) {
      next.set(memberId, lastSeenAt);
    }
  }
  return next;
}

export function sendTypingPingIfDue({
  client,
  conversationId,
  lastSentAt,
  now,
  cooldownMs = TYPING_COOLDOWN_MS,
}: {
  client: TypingSenderClient;
  conversationId: string | null;
  lastSentAt: number;
  now: number;
  cooldownMs?: number;
}) {
  if (!conversationId) {
    return lastSentAt;
  }
  if (now - lastSentAt < cooldownMs) {
    return lastSentAt;
  }

  void (async () => {
    try {
      await client.sendTyping(conversationId);
    } catch {
      // Typing pings are best-effort and should never block composing.
    }
  })();
  return now;
}

export function useTypingSender(client: KiloChatClient, conversationId: string | null) {
  const lastSentAtRef = useRef(0);

  return useCallback(() => {
    lastSentAtRef.current = sendTypingPingIfDue({
      client,
      conversationId,
      lastSentAt: lastSentAtRef.current,
      now: Date.now(),
    });
  }, [client, conversationId]);
}

export function useMobileTypingState({
  client,
  currentUserId,
  sandboxId,
  conversationId,
}: {
  client: KiloChatClient;
  currentUserId: string | null;
  sandboxId: string | null;
  conversationId: string | null;
}) {
  const expectedContext = useMemo(
    () =>
      sandboxId && conversationId ? kiloclawConversationContext(sandboxId, conversationId) : null,
    [conversationId, sandboxId]
  );
  const [typingMembers, setTypingMembers] = useState<Map<string, number>>(new Map());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const clearTimer = useCallback((memberId: string) => {
    const timer = timersRef.current.get(memberId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    timersRef.current.delete(memberId);
  }, []);

  const clearTypingForMember = useCallback(
    (ctx: string, memberId: string) => {
      if (!expectedContext || ctx !== expectedContext) {
        return;
      }
      clearTimer(memberId);
      setTypingMembers(prev => applyTypingStopped(prev, { ctx, memberId, expectedContext }));
    },
    [clearTimer, expectedContext]
  );

  const handleTyping = useCallback(
    (ctx: string, event: TypingEvent) => {
      if (!expectedContext || ctx !== expectedContext) {
        return;
      }
      if (event.memberId === currentUserId) {
        return;
      }

      const now = Date.now();
      setTypingMembers(prev =>
        applyTypingStarted(pruneStaleTypingMembers(prev, now), {
          ctx,
          event,
          currentUserId,
          expectedContext,
          now,
        })
      );

      clearTimer(event.memberId);
      const timer = setTimeout(() => {
        setTypingMembers(prev => {
          const next = new Map(prev);
          next.delete(event.memberId);
          return next;
        });
        timersRef.current.delete(event.memberId);
      }, TYPING_DISPLAY_TIMEOUT_MS);
      timersRef.current.set(event.memberId, timer);
    },
    [clearTimer, currentUserId, expectedContext]
  );

  useEffect(() => {
    setTypingMembers(new Map());
    for (const timer of timersRef.current.values()) {
      clearTimeout(timer);
    }
    timersRef.current.clear();
  }, [expectedContext]);

  useEffect(() => {
    if (!expectedContext) {
      return undefined;
    }

    const offs = [
      client.onTyping(handleTyping),
      client.onTypingStop((ctx, event) => {
        clearTypingForMember(ctx, event.memberId);
      }),
    ];
    return () => {
      for (const off of offs) {
        off();
      }
    };
  }, [client, clearTypingForMember, expectedContext, handleTyping]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);

  return { typingMembers, clearTypingForMember };
}
