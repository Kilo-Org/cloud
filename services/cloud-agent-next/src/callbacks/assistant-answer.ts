import type { Kilo2Message } from '../shared/kilo2-conversation.js';
import type { AssistantMessagePart } from '../session/types.js';

export type AnswerToolStatus = 'pending' | 'running' | 'completed' | 'error';

/**
 * What a callback reports from one assistant message. Each native version has
 * its own reader, so callbacks never depend on a display projection.
 */
export type AssistantAnswer = {
  /** Text items in message order. Reasoning is excluded. */
  text: string;
  tools: { name: string; status: AnswerToolStatus }[];
};

const TOOL_STATUSES: ReadonlySet<string> = new Set(['pending', 'running', 'completed', 'error']);

function isToolStatus(value: unknown): value is AnswerToolStatus {
  return typeof value === 'string' && TOOL_STATUSES.has(value);
}

/** Reads a Kilo v1 message from its stored parts, which sort in creation order. */
export function readV1Answer(parts: readonly AssistantMessagePart[]): AssistantAnswer {
  const answer: AssistantAnswer = { text: '', tools: [] };
  for (const part of parts) {
    if (part.type === 'text' && typeof part.text === 'string') answer.text += part.text;
    else if (part.type === 'tool' && typeof part.tool === 'string') {
      const state = part.state;
      const status =
        typeof state === 'object' && state !== null && 'status' in state ? state.status : undefined;
      if (isToolStatus(status)) answer.tools.push({ name: part.tool, status });
    }
  }
  return answer;
}

/** Reads a Kilo v2 message from its native content, which is in message order. */
export function readKilo2Answer(message: Kilo2Message): AssistantAnswer {
  const answer: AssistantAnswer = { text: '', tools: [] };
  for (const item of message.content ?? []) {
    if (item.type === 'text') answer.text += item.text ?? '';
    else if (item.type === 'tool' && item.name && item.state)
      answer.tools.push({
        name: item.name,
        status: item.state.status === 'streaming' ? 'pending' : item.state.status,
      });
  }
  return answer;
}
