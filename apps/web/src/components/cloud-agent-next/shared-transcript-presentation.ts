import type { Part, StoredMessage, ToolPart } from '@/components/cloud-agent-next/types';
import {
  isAssistantMessage,
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
import { sortSessionMessagesForDisplay } from '@/lib/cloud-agent-next/message-ordering';

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
  for (const message of sortSessionMessagesForDisplay(messages)) {
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

export function groupConsecutiveAssistantMessages(messages: StoredMessage[]): StoredMessage[][] {
  const turns: StoredMessage[][] = [];
  for (const message of messages) {
    const lastTurn = turns.at(-1);
    const lastMessage = lastTurn?.at(-1);
    if (
      lastTurn &&
      lastMessage &&
      isAssistantMessage(lastMessage.info) &&
      isAssistantMessage(message.info)
    ) {
      lastTurn.push(message);
      continue;
    }
    turns.push([message]);
  }
  return turns;
}

function isSnapshotProgressPart(part: Part): boolean {
  return isTextPart(part) && part.synthetic === true && part.text.includes('Initializing snapshot');
}

function isHiddenSharedPart(part: Part): boolean {
  if (isSnapshotProgressPart(part)) {
    return true;
  }
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

const TOOL_FILE_ID_SEPARATOR = '_file_';

/** Native v2 projects files a tool returned as `${toolPartId}_file_${index}` file parts. */
function producingToolPartId(part: Part): string | undefined {
  if (!isFilePart(part)) return undefined;
  const separator = part.id.lastIndexOf(TOOL_FILE_ID_SEPARATOR);
  return separator > 0 ? part.id.slice(0, separator) : undefined;
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

export function summarizeAgentWork(parts: Part[], working = false): string {
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
  const worked = working
    ? 'Working'
    : durations.length > 0
      ? formatWorkedDuration(durations.reduce((a, b) => a + b, 0))
      : null;

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

export function groupAssistantParts(
  parts: Part[],
  mode: 'shared' | 'live' = 'shared'
): SharedTranscriptSegment[] {
  const segments: SharedTranscriptSegment[] = [];
  const toolSegmentTypes = new Map<string, SharedTranscriptSegment['type']>();

  for (const part of parts) {
    if (isHiddenSharedPart(part) && !(mode === 'live' && isSnapshotProgressPart(part))) {
      continue;
    }

    const standaloneTool =
      mode === 'live' &&
      isToolPart(part) &&
      (part.tool === 'question' ||
        part.tool === 'task' ||
        part.tool === 'suggest' ||
        part.state.status === 'error');
    const toolId = producingToolPartId(part);
    // A tool's returned files stay beside that tool instead of ending its group.
    const type =
      (toolId === undefined ? undefined : toolSegmentTypes.get(toolId)) ??
      (isChatPart(part) || standaloneTool ? 'chat' : 'agent-work');
    if (isToolPart(part)) toolSegmentTypes.set(part.id, type);
    const last = segments.at(-1);
    if (last?.type === type) {
      last.parts.push(part);
      continue;
    }

    if (type === 'agent-work') {
      segments.push({ type, parts: [part], summary: '' });
    } else {
      segments.push({ type, parts: [part] });
    }
  }

  for (const segment of segments) {
    if (segment.type === 'agent-work') segment.summary = summarizeAgentWork(segment.parts);
  }

  return segments;
}
