import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Text of one content part. Text parts carry a `text` field in every API (`text`, `input_text`).
 * Anthropic nests model-visible text under `content` (`tool_result`, `search_result`, server tool
 * results) and in document sources. Images, audio, and files carry no text.
 */
function partTexts(part: unknown): string[] {
  if (!isRecord(part)) return [];
  if (typeof part.text === 'string') return [part.text];
  if (part.content !== undefined) return contentTexts(part.content);
  if (isRecord(part.source)) {
    if (part.source.type === 'text' && typeof part.source.data === 'string') {
      return [part.source.data];
    }
    if (part.source.type === 'content') return contentTexts(part.source.content);
  }
  return [];
}

/** Text of a message content or tool output: a string, one part, or a list of parts. */
function contentTexts(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (Array.isArray(content)) return content.flatMap(partTexts);
  return partTexts(content);
}

/**
 * `assistant` items end the scanned turn. Their `texts` are results of tools the provider ran
 * inside that assistant turn, which the request replays as input but no earlier request carried.
 */
type TurnItem =
  | { kind: 'assistant'; texts: string[] }
  | { kind: 'input'; texts: string[] }
  | { kind: 'other' };

function chatCompletionsItem(message: unknown): TurnItem {
  if (!isRecord(message)) return { kind: 'other' };
  if (message.role === 'assistant') return { kind: 'assistant', texts: [] };
  if (message.role === 'user' || message.role === 'tool' || message.role === 'function') {
    return { kind: 'input', texts: contentTexts(message.content) };
  }
  return { kind: 'other' };
}

function messagesItem(message: unknown): TurnItem {
  if (!isRecord(message)) return { kind: 'other' };
  if (message.role === 'assistant') {
    const blocks: unknown[] = Array.isArray(message.content) ? message.content : [];
    return {
      kind: 'assistant',
      texts: blocks.flatMap(block =>
        isRecord(block) && typeof block.type === 'string' && block.type.endsWith('_tool_result')
          ? partTexts(block)
          : []
      ),
    };
  }
  if (message.role === 'user') return { kind: 'input', texts: contentTexts(message.content) };
  return { kind: 'other' };
}

function responsesServerToolTexts(item: Record<string, unknown>): string[] {
  if (item.type === 'mcp_call' && typeof item.output === 'string') return [item.output];
  if (item.type === 'file_search_call' && Array.isArray(item.results)) {
    const results: unknown[] = item.results;
    return results.flatMap(result =>
      isRecord(result) && typeof result.text === 'string' ? [result.text] : []
    );
  }
  return [];
}

function responsesItem(item: unknown): TurnItem {
  if (!isRecord(item)) return { kind: 'other' };
  const type = typeof item.type === 'string' ? item.type : undefined;
  if (item.role === 'assistant' || type === 'reasoning' || type?.endsWith('_call')) {
    return { kind: 'assistant', texts: responsesServerToolTexts(item) };
  }
  if (item.role === 'user') return { kind: 'input', texts: contentTexts(item.content) };
  if (type?.endsWith('_call_output')) return { kind: 'input', texts: contentTexts(item.output) };
  return { kind: 'other' };
}

/**
 * The input items after the last assistant turn and the server tool results inside that turn,
 * oldest first. Assistant items at the very end (an Anthropic prefill) are skipped so they do not
 * hide the user turn that precedes them.
 */
function textsSinceLastAssistantTurn(items: unknown[], classify: (item: unknown) => TurnItem) {
  const collected: string[][] = [];
  let sawInput = false;
  let inAssistantTurn = false;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = classify(items[index]);
    if (item.kind === 'assistant') {
      if (sawInput) {
        inAssistantTurn = true;
        collected.push(item.texts);
      }
      continue;
    }
    if (inAssistantTurn) break;
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
