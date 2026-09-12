import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function renameJsonRefProperties(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.reduce<boolean>(
      (changed, item) => renameJsonRefProperties(item) || changed,
      false
    );
  }

  if (!isRecord(value)) {
    return false;
  }

  let changed = false;
  for (const [key, nestedValue] of Object.entries(value)) {
    changed = renameJsonRefProperties(nestedValue) || changed;
    if (key === '$ref') {
      delete value.$ref;
      value._ref = nestedValue;
      changed = true;
    }
  }
  return changed;
}

function sanitizeJsonRefContent(content: string): string {
  try {
    const result: unknown = JSON.parse(content);
    return renameJsonRefProperties(result) ? JSON.stringify(result) : content;
  } catch {
    return content;
  }
}

export function sanitizeJsonRefToolResults(request: GatewayRequest) {
  if (request.kind !== 'chat_completions') {
    return;
  }

  for (const message of request.body.messages) {
    if (message.role !== 'tool') {
      continue;
    }

    if (typeof message.content === 'string') {
      message.content = sanitizeJsonRefContent(message.content);
    } else {
      for (const part of message.content) {
        if (part.type === 'text') {
          part.text = sanitizeJsonRefContent(part.text);
        }
      }
    }
  }
}
