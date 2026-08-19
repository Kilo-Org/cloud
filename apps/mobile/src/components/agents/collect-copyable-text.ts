import {
  type Part,
  type ReasoningPart,
  type TextPart,
  type ToolPart,
} from '@kilocode/cloud-agent-sdk';

type CopyableMessage = {
  parts: readonly Part[];
};

function isTextPart(part: Part): part is TextPart {
  return part.type === 'text';
}

function isReasoningPart(part: Part): part is ReasoningPart {
  return part.type === 'reasoning';
}

function isToolPart(part: Part): part is ToolPart {
  return part.type === 'tool';
}

function isSnapshotProgressText(part: TextPart): boolean {
  return part.synthetic === true && part.text.includes('Initializing snapshot');
}

function formatToolInput(input: Record<string, unknown>): string {
  const keys = Object.keys(input);
  if (keys.length === 0) {
    return '';
  }
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return '[unserializable input]';
  }
}

function collectToolPartText(part: ToolPart): string {
  const payload: string[] = [];
  const inputText = formatToolInput(part.state.input);
  if (inputText) {
    payload.push(inputText);
  }
  if (part.state.status === 'completed' && part.state.output) {
    payload.push(part.state.output);
  }
  if (part.state.status === 'error' && part.state.error) {
    payload.push(`Error: ${part.state.error}`);
  }
  // No payload yet (pending/running without output): nothing worth copying.
  if (payload.length === 0) {
    return '';
  }
  return [part.tool, ...payload].join('\n');
}

export function collectCopyableText(message: CopyableMessage): string {
  return message.parts
    .map(part => {
      if (isTextPart(part)) {
        return isSnapshotProgressText(part) ? '' : part.text;
      }
      if (isReasoningPart(part)) {
        return part.text;
      }
      if (isToolPart(part)) {
        return collectToolPartText(part);
      }
      return '';
    })
    .filter(text => text.length > 0)
    .join('\n\n');
}
