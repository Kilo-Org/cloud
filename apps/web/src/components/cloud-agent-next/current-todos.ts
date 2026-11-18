import type { StoredMessage, ToolPart } from './types';
import { getTodoPresentation } from './tool-todos';

export type CurrentTodos = ReturnType<typeof getTodoPresentation> & {
  sourcePartId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function todoSourceMetadata(part: ToolPart): { todos?: unknown; view?: unknown } | undefined {
  if (part.state.status === 'pending') return undefined;
  const metadata = part.state.metadata;
  if (!metadata) return undefined;
  const view = metadata.view;
  if (Array.isArray(metadata.todos) || (isRecord(view) && Array.isArray(view.todos))) {
    return metadata;
  }
  return undefined;
}

function hasTodoSource(part: ToolPart): boolean {
  return todoSourceMetadata(part) !== undefined || Array.isArray(part.state.input.todos);
}

export function getCurrentTodos(messages: readonly StoredMessage[]): CurrentTodos | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const parts = messages[messageIndex]?.parts;
    if (!parts) continue;
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
      const part = parts[partIndex];
      if (
        !part ||
        part.type !== 'tool' ||
        part.tool !== 'todowrite' ||
        part.state.status === 'error' ||
        !hasTodoSource(part)
      ) {
        continue;
      }
      return {
        ...getTodoPresentation(part.state.input.todos, todoSourceMetadata(part)),
        sourcePartId: part.id,
      };
    }
  }
  return null;
}
