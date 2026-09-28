import { type Part } from '@kilocode/cloud-agent-sdk';

import { i18n } from '@/i18n';

import { isSnapshotProgressPart } from './part-types';

const toolStatusKeyMap = {
  read: 'agentChat.computeStatus.exploring',
  grep: 'agentChat.computeStatus.searchingCodebase',
  glob: 'agentChat.computeStatus.searchingCodebase',
  list: 'agentChat.computeStatus.searchingCodebase',
  edit: 'agentChat.computeStatus.makingEdits',
  write: 'agentChat.computeStatus.makingEdits',
  bash: 'agentChat.computeStatus.runningCommands',
  websearch: 'agentChat.computeStatus.searchingWeb',
  webfetch: 'agentChat.computeStatus.searchingWeb',
  codesearch: 'agentChat.computeStatus.searchingWeb',
  todowrite: 'agentChat.computeStatus.planningNextSteps',
  todoread: 'agentChat.computeStatus.planningNextSteps',
  task: 'agentChat.computeStatus.delegatingWork',
  question: 'agentChat.computeStatus.askingQuestion',
} as const;

/** Matches CLI PROGRESS_INITIALIZING typography (U+2026 ellipsis). */
export const SNAPSHOT_PROGRESS_STATUS = 'Initializing snapshot…';

export function computeStatus(part: Part): string {
  if (part.type === 'tool') {
    return Object.hasOwn(toolStatusKeyMap, part.tool)
      ? i18n.t(toolStatusKeyMap[part.tool as keyof typeof toolStatusKeyMap])
      : i18n.t('agentChat.computeStatus.consideringNextSteps');
  }
  if (part.type === 'reasoning') {
    return i18n.t('agentChat.partDetail.thinking');
  }
  if (part.type === 'text') {
    if (isSnapshotProgressPart(part)) {
      return i18n.t('agentChat.computeStatus.initializingSnapshot');
    }
    return i18n.t('agentChat.computeStatus.writingResponse');
  }
  return i18n.t('agentChat.computeStatus.consideringNextSteps');
}

/**
 * opencode pre-creates an empty `text` part for the response block before any
 * token arrives, and its id sorts after the reasoning part (a stream looks
 * like `[step-start, reasoning, text(0)]`). Reading the raw last part would
 * therefore label the whole reasoning stream "Writing response", and the
 * spinner would never read "Thinking". Skip empty text placeholders and
 * describe the last part that actually carries activity.
 */
export function lastActivePart(parts: readonly Part[]): Part | undefined {
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i];
    if (part !== undefined && !(part.type === 'text' && part.text === '')) {
      return part;
    }
  }
  return undefined;
}

/** Spinner label for an assistant message's parts. */
export function computeMessageStatus(parts: readonly Part[]): string {
  const part = lastActivePart(parts);
  return part ? computeStatus(part) : i18n.t('agentChat.computeStatus.consideringNextSteps');
}
