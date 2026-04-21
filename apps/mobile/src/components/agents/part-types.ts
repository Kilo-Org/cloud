import {
  type CompactionPart,
  type FilePart,
  type Part,
  type ReasoningPart,
  type TextPart,
  type ToolPart,
} from 'cloud-agent-sdk';

export function isTextPart(part: Part): part is TextPart {
  return part.type === 'text';
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
