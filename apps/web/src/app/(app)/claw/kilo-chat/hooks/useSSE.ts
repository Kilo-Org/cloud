import { useEffect, useRef } from 'react';
import { KILO_CHAT_URL } from '@/lib/constants';
import type {
  MessageCreatedEvent,
  MessageUpdatedEvent,
  MessageDeletedEvent,
  TypingEvent,
} from '../types';

type SSEEvent =
  | { type: 'message.created'; data: MessageCreatedEvent }
  | { type: 'message.updated'; data: MessageUpdatedEvent }
  | { type: 'message.deleted'; data: MessageDeletedEvent }
  | { type: 'typing'; data: TypingEvent };

type UseSSEOptions = {
  conversationId: string | null;
  token: string | null;
  onEvent: (event: SSEEvent) => void;
};

export function useSSE({ conversationId, token, onEvent }: UseSSEOptions) {
  const lastEventIdRef = useRef<string | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!conversationId || !token) return;

    let aborted = false;
    const controller = new AbortController();

    async function connect() {
      while (!aborted) {
        try {
          const url = `${KILO_CHAT_URL}/v1/conversations/${conversationId}/events`;
          const headers: Record<string, string> = {
            Authorization: `Bearer ${token}`,
          };
          if (lastEventIdRef.current) {
            headers['Last-Event-ID'] = lastEventIdRef.current;
          }

          const res = await fetch(url, {
            headers,
            signal: controller.signal,
          });

          if (!res.ok || !res.body) {
            await new Promise(r => setTimeout(r, 3000));
            continue;
          }

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let currentEvent = '';
          let currentData = '';
          let currentId = '';

          while (!aborted) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              if (line.startsWith('event:')) {
                currentEvent = line.slice(6).trim();
              } else if (line.startsWith('data:')) {
                currentData = line.slice(5).trim();
              } else if (line.startsWith('id:')) {
                currentId = line.slice(3).trim();
              } else if (line === '') {
                if (currentEvent && currentData) {
                  if (currentId) lastEventIdRef.current = currentId;
                  try {
                    const data = JSON.parse(currentData);
                    onEventRef.current({
                      type: currentEvent as SSEEvent['type'],
                      data,
                    });
                  } catch {
                    // Skip malformed events
                  }
                }
                currentEvent = '';
                currentData = '';
                currentId = '';
              }
            }
          }
        } catch (e) {
          if (aborted) return;
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    }

    void connect();

    return () => {
      aborted = true;
      controller.abort();
    };
  }, [conversationId, token]);
}
