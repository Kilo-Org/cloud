import {
  type CompactionPart,
  type FilePart,
  type Part,
  type ReasoningPart,
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

export function isReasoningPart(part: Part): part is ReasoningPart {
  return part.type === 'reasoning';
}

export function isCompactionPart(part: Part): part is CompactionPart {
  return part.type === 'compaction';
}

export function isPartStreaming(part: Part): boolean {
  if (part.type === 'text') {
    return !part.time?.end;
  }
  if (part.type === 'reasoning') {
    return !part.time.end;
  }
  if (part.type === 'tool') {
    return part.state.status === 'pending' || part.state.status === 'running';
  }
  return false;
}

export function shouldRenderReasoningPart(part: Part, _isStreaming: boolean): boolean {
  if (!isReasoningPart(part)) {
    return false;
  }
  return part.text.trim() !== '';
}
