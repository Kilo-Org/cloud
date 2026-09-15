import type {
  PreparationAttempt,
  SessionCommit,
  SessionStatusIndicator,
} from '@kilocode/cloud-agent-sdk';
import type { Part, StoredMessage, ToolPart } from './types';
import { isAssistantMessage, shouldRenderReasoningPart } from './types';

export function groupConversationMessages(
  messages: StoredMessage[],
  preparationByMessageId: ReadonlyMap<string, readonly PreparationAttempt[]>,
  commitsAfterMessage: ReadonlyMap<string, readonly SessionCommit[]> = new Map()
): StoredMessage[][] {
  const groups: StoredMessage[][] = [];

  for (const message of messages) {
    const previousGroup = groups.at(-1);
    const previous = previousGroup?.at(-1);
    if (
      previousGroup &&
      previous &&
      isAssistantMessage(previous.info) &&
      isAssistantMessage(message.info) &&
      previous.info.sessionID === message.info.sessionID &&
      previous.info.parentID === message.info.parentID &&
      previous.info.error == null &&
      message.info.error == null &&
      !commitsAfterMessage.has(previous.info.id) &&
      !preparationByMessageId.get(previous.info.id)?.length &&
      !preparationByMessageId.get(message.info.id)?.length
    ) {
      previousGroup.push(message);
    } else {
      groups.push([message]);
    }
  }

  return groups;
}

export function commitsByMessageAnchor(
  messages: readonly StoredMessage[],
  commits: readonly SessionCommit[]
): ReadonlyMap<string, readonly SessionCommit[]> {
  const messagesById = new Map(messages.map(message => [message.info.id, message]));
  const byAnchor = new Map<string, SessionCommit[]>();
  const seen = new Set<string>();
  const time = (commit: SessionCommit) => {
    const value = Date.parse(commit.committedAt ?? commit.timestamp ?? '');
    return Number.isFinite(value) ? value : 0;
  };
  const ordered = [...commits].sort(
    (a, b) => time(a) - time(b) || a.commitHash.localeCompare(b.commitHash)
  );
  for (const commit of ordered) {
    if (seen.has(commit.commitHash)) continue;
    seen.add(commit.commitHash);
    const assistant = messagesById.get(commit.messageId);
    let anchor = assistant?.info.role === 'assistant' ? assistant.info.id : undefined;
    if (!anchor && commit.messageId === commit.userMessageId) {
      const user = messagesById.get(commit.userMessageId);
      if (user?.info.role !== 'user') continue;
      const turn = messages.filter(
        message =>
          message.info.role === 'assistant' &&
          message.info.parentID === user.info.id &&
          message.info.sessionID === user.info.sessionID
      );
      if (
        turn.some(
          message => message.info.role === 'assistant' && message.info.time.completed === undefined
        )
      )
        continue;
      anchor = turn.at(-1)?.info.id ?? user.info.id;
    }
    if (!anchor) continue;
    const anchored = byAnchor.get(anchor) ?? [];
    anchored.push(commit);
    byAnchor.set(anchor, anchored);
  }
  return byAnchor;
}

export function isCommitSummaryRepresented(
  indicator: SessionStatusIndicator | null,
  commitsAfterMessage: ReadonlyMap<string, readonly SessionCommit[]>
): boolean {
  return (
    indicator?.type === 'info' &&
    indicator.commitHash !== undefined &&
    [...commitsAfterMessage.values()].some(commits =>
      commits.some(commit => commit.commitHash === indicator.commitHash)
    )
  );
}

export function shouldRenderToolPart(part: ToolPart): boolean {
  if (part.tool === 'plan_enter' || part.tool === 'plan_exit' || part.tool === 'todoread') {
    return false;
  }
  return part.tool !== 'todowrite' || part.state.status === 'completed';
}

export function getVisibleAssistantParts(parts: Part[]): Part[] {
  return parts.filter(part => {
    switch (part.type) {
      case 'step-start':
      case 'step-finish':
      case 'patch':
        return false;
      case 'reasoning':
        return shouldRenderReasoningPart(part);
      case 'text':
        return part.text.trim() !== '';
      case 'tool':
        return shouldRenderToolPart(part);
      default:
        return true;
    }
  });
}
