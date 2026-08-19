import type { Part, StoredMessage, ToolPart } from '@/components/cloud-agent-next/types';
import {
  isFilePart,
  isPatchPart,
  isReasoningPart,
  isStepFinishPart,
  isStepStartPart,
  isSubtaskPart,
  isTextPart,
  isToolPart,
  shouldRenderReasoningPart,
} from '@/components/cloud-agent-next/types';

type SnapshotMessage = {
  info: { id: string; role?: unknown; time?: unknown };
  parts: Array<{ id: string }>;
};

export type SharedTranscriptSegment =
  | { type: 'chat'; parts: Part[] }
  | { type: 'agent-work'; parts: Part[]; summary: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasCreatedTime(info: SnapshotMessage['info']): boolean {
  if (!isRecord(info.time)) {
    return false;
  }
  return typeof info.time.created === 'number';
}

export function toSharedTranscriptMessages(messages: SnapshotMessage[]): StoredMessage[] {
  const result: StoredMessage[] = [];
  for (const message of messages) {
    if (message.info.role !== 'user' && message.info.role !== 'assistant') {
      continue;
    }
    if (!hasCreatedTime(message.info)) {
      continue;
    }
    result.push(message as StoredMessage);
  }
  return result;
}

function isHiddenSharedPart(part: Part): boolean {
  if (isStepStartPart(part) || isStepFinishPart(part) || isPatchPart(part)) {
    return true;
  }
  if (isToolPart(part) && (part.tool === 'plan_enter' || part.tool === 'plan_exit')) {
    return true;
  }
  if (isReasoningPart(part) && !shouldRenderReasoningPart(part)) {
    return true;
  }
  return false;
}

function isChatPart(part: Part): boolean {
  return isTextPart(part) || isFilePart(part);
}

function toolDurationMs(part: ToolPart): number | null {
  const { state } = part;
  if (state.status !== 'completed' && state.status !== 'error') {
    return null;
  }
  if (typeof state.time.start !== 'number' || typeof state.time.end !== 'number') {
    return null;
  }
  const duration = state.time.end - state.time.start;
  return duration > 0 ? duration : null;
}

function reasoningDurationMs(part: Part): number | null {
  if (!isReasoningPart(part)) {
    return null;
  }
  if (typeof part.time.start !== 'number' || typeof part.time.end !== 'number') {
    return null;
  }
  const duration = part.time.end - part.time.start;
  return duration > 0 ? duration : null;
}

function formatWorkedDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  if (totalSeconds < 60) {
    return `Worked for ${totalSeconds}s`;
  }
  const minutes = Math.round(totalSeconds / 60);
  return minutes === 1 ? 'Worked for 1 minute' : `Worked for ${minutes} minutes`;
}

export function summarizeAgentWork(parts: Part[]): string {
  const tools = parts.filter(isToolPart);
  const reasoning = parts.filter(shouldRenderReasoningPart);
  const subtasks = parts.filter(isSubtaskPart);

  const details: string[] = [];
  if (tools.length === 1) {
    details.push('1 tool call');
  } else if (tools.length > 1) {
    details.push(`${tools.length} tool calls`);
  }
  if (reasoning.length > 0) {
    details.push('reasoning');
  }
  if (subtasks.length === 1) {
    details.push('1 subtask');
  } else if (subtasks.length > 1) {
    details.push(`${subtasks.length} subtasks`);
  }

  const durations = parts
    .map(part => (isToolPart(part) ? toolDurationMs(part) : reasoningDurationMs(part)))
    .filter((duration): duration is number => duration !== null);
  const worked =
    durations.length > 0 ? formatWorkedDuration(durations.reduce((a, b) => a + b, 0)) : null;

  if (worked && details.length > 0) {
    return `${worked} · ${details.join(' · ')}`;
  }
  if (worked) {
    return worked;
  }
  if (details.length > 0) {
    return details.join(' · ');
  }
  return 'Agent work';
}

export function groupAssistantParts(parts: Part[]): SharedTranscriptSegment[] {
  const segments: SharedTranscriptSegment[] = [];

  for (const part of parts) {
    if (isHiddenSharedPart(part)) {
      continue;
    }

    const type = isChatPart(part) ? 'chat' : 'agent-work';
    const last = segments.at(-1);
    if (last?.type === type) {
      last.parts.push(part);
      if (last.type === 'agent-work') {
        last.summary = summarizeAgentWork(last.parts);
      }
      continue;
    }

    if (type === 'agent-work') {
      segments.push({ type, parts: [part], summary: summarizeAgentWork([part]) });
    } else {
      segments.push({ type, parts: [part] });
    }
  }

  return segments;
}
