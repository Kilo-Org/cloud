type TextPartLike = { type: string; text: string; synthetic?: boolean };

type ReasoningPartLike = { type: string; text: string };

type ToolStateLike =
  | { status: 'pending'; input: Record<string, unknown> }
  | { status: 'running'; input: Record<string, unknown>; title?: string }
  | { status: 'completed'; input: Record<string, unknown>; output: string; title: string }
  | { status: 'error'; input: Record<string, unknown>; error: string };

type ToolPartLike = {
  type: string;
  tool: string;
  state: ToolStateLike;
};

type CopyablePart = TextPartLike | ReasoningPartLike | ToolPartLike | { type: string };

type CopyableMessage = {
  parts: readonly CopyablePart[];
};

function isTextPartLike(part: CopyablePart): part is TextPartLike {
  return part.type === 'text' && typeof (part as TextPartLike).text === 'string';
}

function isReasoningPartLike(part: CopyablePart): part is ReasoningPartLike {
  return part.type === 'reasoning' && typeof (part as ReasoningPartLike).text === 'string';
}

function isToolPartLike(part: CopyablePart): part is ToolPartLike {
  return (
    part.type === 'tool' &&
    typeof (part as ToolPartLike).tool === 'string' &&
    typeof (part as ToolPartLike).state === 'object' &&
    typeof (part as ToolPartLike).state.status === 'string'
  );
}

function isSnapshotProgressText(part: TextPartLike): boolean {
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

function collectToolPartText(part: ToolPartLike): string {
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
      if (isTextPartLike(part)) {
        return isSnapshotProgressText(part) ? '' : part.text;
      }
      if (isReasoningPartLike(part)) {
        return part.text;
      }
      if (isToolPartLike(part)) {
        return collectToolPartText(part);
      }
      return '';
    })
    .filter(text => text.length > 0)
    .join('\n\n');
}
