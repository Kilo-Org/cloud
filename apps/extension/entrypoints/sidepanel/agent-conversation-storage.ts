import { storage } from '#imports';
import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { AgentConversationEvent } from '@/src/shared/agent-conversation';

const conversationStorageKey = 'local:kiloAgentConversation';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isMessageEvent = (value: Record<string, unknown>): boolean =>
  value['type'] === 'message' &&
  (value['role'] === 'assistant' || value['role'] === 'user') &&
  typeof value['id'] === 'string' &&
  typeof value['text'] === 'string';

const isThinkingEvent = (value: Record<string, unknown>): boolean =>
  value['type'] === 'thinking' &&
  typeof value['id'] === 'string' &&
  typeof value['text'] === 'string';

const isToolCallEvent = (value: Record<string, unknown>): boolean =>
  value['type'] === 'tool-call' &&
  value['name'] === 'eval' &&
  typeof value['code'] === 'string' &&
  typeof value['id'] === 'string' &&
  typeof value['tabId'] === 'number';

const isToolResultEvent = (value: Record<string, unknown>): boolean =>
  value['type'] === 'tool-result' &&
  typeof value['id'] === 'string' &&
  typeof value['ok'] === 'boolean' &&
  typeof value['toolCallId'] === 'string';

const normalizeConversationEvents = (value: unknown): AgentConversationEvent[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.every(
    event =>
      isRecord(event) &&
      (isMessageEvent(event) ||
        isThinkingEvent(event) ||
        isToolCallEvent(event) ||
        isToolResultEvent(event))
  )
    ? value
    : undefined;
};

export const clearStoredAgentConversation = async (): Promise<void> => {
  await storage.removeItem(conversationStorageKey);
};

export const useStoredAgentConversation = (
  createDefaultEvents: () => AgentConversationEvent[]
): readonly [AgentConversationEvent[], Dispatch<SetStateAction<AgentConversationEvent[]>>] => {
  const [events, setEvents] = useState<AgentConversationEvent[]>(createDefaultEvents);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    let isCurrent = true;

    void (async (): Promise<void> => {
      const storedEvents = normalizeConversationEvents(
        await storage.getItem(conversationStorageKey)
      );

      if (!isCurrent) {
        return;
      }

      setEvents(storedEvents ?? createDefaultEvents());
      setIsLoaded(true);
    })();

    return () => {
      isCurrent = false;
    };
  }, [createDefaultEvents]);

  useEffect(() => {
    if (isLoaded) {
      void storage.setItem(conversationStorageKey, events);
    }
  }, [events, isLoaded]);

  return [events, setEvents];
};
