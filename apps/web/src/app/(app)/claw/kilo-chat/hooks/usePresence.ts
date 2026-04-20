import { useEffect, useState } from 'react';
import type { EventServiceClient } from '@kilocode/event-service';

/**
 * Manages presence for the current user in a conversation context.
 * Shows presence on mount, hides on unmount.
 * Builds present member set from join/leave events.
 */
export function usePresence(
  eventService: EventServiceClient,
  context: string | null
): Set<string> {
  const [members, setMembers] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!context) return;

    eventService.showPresence(context);

    const offs = [
      eventService.onPresenceJoined((ctx, userId) => {
        if (ctx === context) {
          setMembers(prev => {
            if (prev.has(userId)) return prev;
            const next = new Set(prev);
            next.add(userId);
            return next;
          });
        }
      }),
      eventService.onPresenceLeft((ctx, userId) => {
        if (ctx === context) {
          setMembers(prev => {
            if (!prev.has(userId)) return prev;
            const next = new Set(prev);
            next.delete(userId);
            return next;
          });
        }
      }),
    ];

    return () => {
      eventService.hidePresence(context);
      offs.forEach(off => off());
      setMembers(new Set());
    };
  }, [eventService, context]);

  return members;
}
