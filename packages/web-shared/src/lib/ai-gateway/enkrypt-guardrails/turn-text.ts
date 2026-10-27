import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

type JsonObject = Record<string, unknown>;

const CHAT_TEXT_PARTS: ReadonlySet<string> = new Set(['text']);
const RESPONSES_TEXT_PARTS: ReadonlySet<string> = new Set(['input_text', 'output_text', 'text']);

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textsOf(content: unknown, partTypes: ReadonlySet<string>): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap(part =>
    isObject(part) &&
    typeof part.type === 'string' &&
    partTypes.has(part.type) &&
    typeof part.text === 'string'
      ? [part.text]
      : []
  );
}

function itemsSinceLastAssistantTurn(
  items: unknown[],
  isAssistantTurn: (item: JsonObject) => boolean
): JsonObject[] {
  const lastAssistantIndex = items.findLastIndex(item => isObject(item) && isAssistantTurn(item));
  return items.slice(lastAssistantIndex + 1).filter(isObject);
}

function chatCompletionsTurnTexts(body: JsonObject): string[] {
  if (!Array.isArray(body.messages)) return [];
  return itemsSinceLastAssistantTurn(
    body.messages,
    message => message.role === 'assistant'
  ).flatMap(message =>
    message.role === 'user' || message.role === 'tool' || message.role === 'function'
      ? textsOf(message.content, CHAT_TEXT_PARTS)
      : []
  );
}

function messagesTurnTexts(body: JsonObject): string[] {
  if (!Array.isArray(body.messages)) return [];
  return itemsSinceLastAssistantTurn(
    body.messages,
    message => message.role === 'assistant'
  ).flatMap(message => {
    if (message.role !== 'user') return [];
    if (!Array.isArray(message.content)) return textsOf(message.content, CHAT_TEXT_PARTS);
    return message.content.flatMap(block => {
      if (!isObject(block)) return [];
      if (block.type === 'text' && typeof block.text === 'string') return [block.text];
      if (block.type === 'tool_result') return textsOf(block.content, CHAT_TEXT_PARTS);
      return [];
    });
  });
}

function isResponsesModelItem(item: JsonObject): boolean {
  if (item.role === 'assistant') return true;
  return (
    typeof item.type === 'string' && (item.type === 'reasoning' || item.type.endsWith('_call'))
  );
}

function responsesTurnTexts(body: JsonObject): string[] {
  if (typeof body.input === 'string') return [body.input];
  if (!Array.isArray(body.input)) return [];
  return itemsSinceLastAssistantTurn(body.input, isResponsesModelItem).flatMap(item => {
    if (item.role === 'user') return textsOf(item.content, RESPONSES_TEXT_PARTS);
    if (typeof item.type === 'string' && item.type.endsWith('_call_output')) {
      return textsOf(item.output, RESPONSES_TEXT_PARTS);
    }
    return [];
  });
}

export function joinScanTexts(texts: ReadonlyArray<string | null | undefined>): string {
  return texts
    .filter((text): text is string => typeof text === 'string' && text.trim().length > 0)
    .join('\n\n');
}

/**
 * The part of the conversation that is new in this request: the latest user
 * message and tool results since the last assistant turn. Earlier turns, system
 * prompts, and tool definitions are excluded so a scan never re-reads history.
 */
export function extractTurnInputText(kind: GatewayRequest['kind'], body: unknown): string {
  if (!isObject(body)) return '';
  switch (kind) {
    case 'chat_completions':
      return joinScanTexts(chatCompletionsTurnTexts(body));
    case 'messages':
      return joinScanTexts(messagesTurnTexts(body));
    case 'responses':
      return joinScanTexts(responsesTurnTexts(body));
  }
}
