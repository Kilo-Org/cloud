import type { EventId } from '../types/ids.js';

export type AssistantMessageInfo = Record<string, unknown> & {
  id: string;
  role: 'assistant';
};

export type AssistantMessagePart = Record<string, unknown> & {
  id: string;
  messageID: string;
};

export type LatestAssistantMessage = {
  eventId: EventId;
  timestamp: number;
  info: AssistantMessageInfo;
  parts: AssistantMessagePart[];
};
