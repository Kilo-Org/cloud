import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Text of a message content or tool output: a string, or a list of parts. Text parts carry a
 * `text` field in every API (`text`, `input_text`); Anthropic nests tool output in `tool_result`
 * blocks and plain-text documents in `source.data`. Images, audio, and files carry no text.
 */
function contentTexts(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  const parts: unknown[] = content;
  return parts.flatMap(part => {
    if (!isRecord(part)) return [];
    if (typeof part.text === 'string') return [part.text];
    if (part.type === 'tool_result') return contentTexts(part.content);
    if (
      part.type === 'document' &&
      isRecord(part.source) &&
      part.source.type === 'text' &&
      typeof part.source.data === 'string'
    ) {
      return [part.source.data];
    }
    return [];
  });
}

type TurnItem = { kind: 'assistant' } | { kind: 'input'; texts: string[] } | { kind: 'other' };

function chatCompletionsItem(message: unknown): TurnItem {
  if (!isRecord(message)) return { kind: 'other' };
  if (message.role === 'assistant') return { kind: 'assistant' };
  if (message.role === 'user' || message.role === 'tool' || message.role === 'function') {
    return { kind: 'input', texts: contentTexts(message.content) };
  }
  return { kind: 'other' };
}

function messagesItem(message: unknown): TurnItem {
  if (!isRecord(message)) return { kind: 'other' };
  if (message.role === 'assistant') return { kind: 'assistant' };
  if (message.role === 'user') return { kind: 'input', texts: contentTexts(message.content) };
  return { kind: 'other' };
}

function responsesItem(item: unknown): TurnItem {
  if (!isRecord(item)) return { kind: 'other' };
  const type = typeof item.type === 'string' ? item.type : undefined;
  if (item.role === 'assistant' || type === 'reasoning' || type?.endsWith('_call')) {
    return { kind: 'assistant' };
  }
  if (item.role === 'user') return { kind: 'input', texts: contentTexts(item.content) };
  if (type?.endsWith('_call_output')) return { kind: 'input', texts: contentTexts(item.output) };
  return { kind: 'other' };
}

/**
 * The input items after the last assistant turn, oldest first. Assistant items at the very end
 * (an Anthropic prefill) are skipped so they do not hide the user turn that precedes them.
 */
function textsSinceLastAssistantTurn(items: unknown[], classify: (item: unknown) => TurnItem) {
  const collected: string[][] = [];
  let sawInput = false;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = classify(items[index]);
    if (item.kind === 'assistant') {
      if (sawInput) break;
      continue;
    }
    if (item.kind === 'input') {
      sawInput = true;
      collected.push(item.texts);
    }
  }
  return collected.reverse().flat();
}

function turnDeltaTexts(request: GatewayRequest): string[] {
  const body: unknown = request.body;
  if (!isRecord(body)) return [];
  if (request.kind === 'responses') {
    if (typeof body.input === 'string') return [body.input];
    return Array.isArray(body.input) ? textsSinceLastAssistantTurn(body.input, responsesItem) : [];
  }
  if (!Array.isArray(body.messages)) return [];
  return textsSinceLastAssistantTurn(
    body.messages,
    request.kind === 'messages' ? messagesItem : chatCompletionsItem
  );
}

/**
 * The new part of the conversation for this turn: the latest user message and the tool results
 * since the last assistant turn, never earlier history or system prompts.
 */
export function extractTurnDeltaText(request: GatewayRequest): string {
  return turnDeltaTexts(request)
    .map(text => text.trim())
    .filter(text => text.length > 0)
    .join('\n\n');
}
