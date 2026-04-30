import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { kiloclawInstanceContext } from '@kilocode/event-service';

import { useEventSubscription } from './use-event-subscription';

const INSTANCE_EVENTS = [
  'conversation.created',
  'conversation.left',
  'message.created',
  'message.updated',
  'message.deleted',
  'bot.status',
] as const;

export function useInstanceEventSubscription(sandboxId: string | undefined) {
  const qc = useQueryClient();
  const onEvent = useCallback(
    ({ event }: { event: string; payload: unknown }) => {
      switch (event) {
        case 'conversation.created':
        case 'conversation.left':
        case 'message.created':
        case 'message.updated':
        case 'message.deleted':
          // message.* invalidates the conversations list so last-message
          // preview and unread counts stay current while the user is on
          // the list (instance-level presence, not viewing a specific conv).
          void qc.invalidateQueries({ queryKey: ['conversations', sandboxId] });
          break;
        case 'bot.status':
          void qc.invalidateQueries({ queryKey: ['bot-status', sandboxId] });
          break;
        default:
          break;
      }
    },
    [qc, sandboxId]
  );
  useEventSubscription(
    sandboxId ? kiloclawInstanceContext(sandboxId) : null,
    INSTANCE_EVENTS,
    onEvent
  );
}
