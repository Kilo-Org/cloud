import { useEffect, useRef, useMemo } from 'react';
import { KiloChatSSE } from '@kilocode/kilo-chat';
import type {
  MessageCreatedEvent,
  MessageUpdatedEvent,
  MessageDeletedEvent,
  TypingEvent,
} from '@kilocode/kilo-chat';
import { KILO_CHAT_URL } from '@/lib/constants';

type SSEEvent =
  | { type: 'message.created'; data: MessageCreatedEvent }
  | { type: 'message.updated'; data: MessageUpdatedEvent }
  | { type: 'message.deleted'; data: MessageDeletedEvent }
  | { type: 'typing'; data: TypingEvent };

type UseSSEOptions = {
  conversationId: string | null;
  getToken: () => Promise<string>;
  onEvent: (event: SSEEvent) => void;
};

export function useSSE({ conversationId, getToken, onEvent }: UseSSEOptions) {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const sse = useMemo(() => new KiloChatSSE({ baseUrl: KILO_CHAT_URL, getToken }), [getToken]);

  useEffect(() => {
    if (!conversationId) return;
    sse.connect(conversationId, {
      onMessageCreated: data => onEventRef.current({ type: 'message.created', data }),
      onMessageUpdated: data => onEventRef.current({ type: 'message.updated', data }),
      onMessageDeleted: data => onEventRef.current({ type: 'message.deleted', data }),
      onTyping: data => onEventRef.current({ type: 'typing', data }),
    });
    return () => sse.disconnect();
  }, [conversationId, sse]);
}
