import {
  type CompactionPart,
  type FilePart,
  type Part,
  type PatchPart,
  type ReasoningPart,
  type StoredMessage,
  type TextPart,
  type ToolPart,
} from '@kilocode/cloud-agent-sdk';

export function isTextPart(part: Part): part is TextPart {
  return part.type === 'text';
}

/**
 * Returns the first text part's text, or '' when there is none.
 * The human-authored prompt is always the first text part, so only `ignored`
 * parts are skipped. A file-only message yields an empty string.
 */
export function firstHumanText(parts: readonly Part[]): string {
  const part = parts.find((p): p is TextPart => isTextPart(p) && p.ignored !== true);
  return part?.text ?? '';
}

/** CLI snapshot-init progress injected as a synthetic text part (matches kilo-vscode). */
export function isSnapshotProgressPart(part: Part): boolean {
  return isTextPart(part) && part.synthetic === true && part.text.includes('Initializing snapshot');
}

export function isToolPart(part: Part): part is ToolPart {
  return part.type === 'tool';
}

export function isFilePart(part: Part): part is FilePart {
  return part.type === 'file';
}

export function isPatchPart(part: Part): part is PatchPart {
  return part.type === 'patch';
}

export function isReasoningPart(part: Part): part is ReasoningPart {
  return part.type === 'reasoning';
}

/**
 * Returns the messages with every reasoning part removed, for the
 * "Hide thinking details" option. A message that has no reasoning part keeps
 * its identity, and the input array itself is returned when nothing changed,
 * so memoized consumers do not churn when thinking is already absent.
 */
export function withoutReasoningParts(messages: readonly StoredMessage[]): StoredMessage[] {
  const next = messages.map(message => {
    const parts = message.parts.filter(part => !isReasoningPart(part));
    if (parts.length === message.parts.length) {
      return message;
    }
    return { ...message, parts };
  });
  const changed = next.some((message, index) => message !== messages[index]);
  // Hand back the input array itself when nothing was removed. Callers only
  // read the result, so widening the readonly view is safe.
  return changed ? next : (messages as StoredMessage[]);
}

export function isCompactionPart(part: Part): part is CompactionPart {
  return part.type === 'compaction';
}

function isOpenEndedTime(time: { end?: number } | undefined): boolean {
  return time !== undefined && !time.end;
}

export function isPartStreaming(part: Part): boolean {
  if (part.type === 'text') {
    return !part.time?.end;
  }
  if (part.type === 'reasoning') {
    return isOpenEndedTime(part.time);
  }
  if (part.type === 'tool') {
    return part.state.status === 'pending' || part.state.status === 'running';
  }
  return false;
}

function hasReasoningText(text: string | undefined): boolean {
  return text != null && text.trim() !== '';
}

export function shouldRenderReasoningPart(part: Part, _isStreaming: boolean): boolean {
  return isReasoningPart(part) && hasReasoningText(part.text);
}
