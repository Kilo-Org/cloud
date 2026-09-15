import {
  type KiloSessionId,
  type Part,
  type StoredMessage,
  type ToolPart,
} from '@kilocode/cloud-agent-sdk';

import { i18n } from '@/i18n';

import { computeStatus, lastActivePart } from './compute-status';
import { isToolPart } from './part-types';
import { getFilename, truncateText } from './tool-card-utils';

export type ChildSessionActivity = { tool: string; context?: string };

export type ChildSessionCardState = {
  agentName: string;
  taskName: string;
  /**
   * Whether `taskName` carries task content worth translating. False when it
   * falls back to the already-localized `agentChat.childSession.task` label, so
   * the subagent card never sends app-language copy to the gateway.
   */
  translatable: boolean;
  latestActivity: ChildSessionActivity | string;
};

function getStringProperty(obj: unknown, key: string): string | undefined {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- generic payload walker over heterogeneous tool inputs; no static shape to narrow against
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return undefined;
  }
  const value = (obj as Record<string, unknown>)[key];
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- generic payload walker over heterogeneous tool inputs; no static shape to narrow against
  return typeof value === 'string' ? value : undefined;
}

function getToolContext(p: ToolPart): string | undefined {
  const input = p.state.input;

  if (p.tool === 'read' || p.tool === 'edit' || p.tool === 'write') {
    const filePath = getStringProperty(input, 'filePath');
    return filePath ? getFilename(filePath) : undefined;
  }
  if (p.tool === 'bash') {
    const command = getStringProperty(input, 'command');
    if (!command) {
      return undefined;
    }
    const firstWord = command.split(/\s+/)[0];
    if (!firstWord) {
      return undefined;
    }
    return truncateText(firstWord, 20);
  }
  if (p.tool === 'glob' || p.tool === 'grep') {
    const pattern = getStringProperty(input, 'pattern');
    if (!pattern) {
      return undefined;
    }
    return truncateText(pattern, 25);
  }
  if (p.tool === 'task') {
    const description = getStringProperty(input, 'description');
    if (!description) {
      return undefined;
    }
    return truncateText(description, 30);
  }
  return undefined;
}

function findLatestAssistantParts(messages: StoredMessage[]): readonly Part[] | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.info.role === 'assistant' && msg.parts.length > 0) {
      return msg.parts;
    }
  }
  return undefined;
}

export function getChildSessionCardState(
  part: ToolPart,
  childMessages: StoredMessage[]
): ChildSessionCardState {
  const input = part.state.input;
  const agentName =
    getStringProperty(input, 'subagent_type') ?? i18n.t('agentChat.childSession.subagent');
  const description = getStringProperty(input, 'description');
  const prompt = getStringProperty(input, 'prompt');
  const taskName =
    description ?? (prompt ? truncateText(prompt, 60) : i18n.t('agentChat.childSession.task'));
  // Same rule as the task tool-card projection: only real input content is
  // translatable; the localized fallback label is not.
  const translatable = description !== undefined || Boolean(prompt);

  const latestActivity: ChildSessionActivity | string = (() => {
    if (part.state.status === 'completed' || part.state.status === 'error') {
      return '';
    }
    const assistantParts = findLatestAssistantParts(childMessages);
    if (assistantParts) {
      const latestPart = lastActivePart(assistantParts);
      if (latestPart) {
        if (isToolPart(latestPart)) {
          return { tool: latestPart.tool, context: getToolContext(latestPart) };
        }
        return computeStatus(latestPart);
      }
    }
    // A running subagent without a loaded child transcript is still working, so
    // the card shows the same "Thinking" label the composer spinner uses while
    // it streams reasoning. A pending task has no child session yet; it is
    // queued and genuinely waiting to start.
    return part.state.status === 'running'
      ? i18n.t('agentChat.partDetail.thinking')
      : i18n.t('agentChat.childSession.waitingForActivity');
  })();

  return { agentName, taskName, translatable, latestActivity };
}

export function getChildSessionActivityLabel(activity: ChildSessionActivity | string): string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- distinguishing the string-vs-object ChildSessionActivity variant has no non-typeof discriminant
  if (typeof activity === 'string') {
    return activity;
  }
  return activity.context ? `${activity.tool} ${activity.context}` : activity.tool;
}

export function getTaskToolSessionId(part: ToolPart): KiloSessionId | undefined {
  if (part.tool !== 'task') {
    return undefined;
  }
  const { state } = part;
  if (state.status === 'running' || state.status === 'completed' || state.status === 'error') {
    return getStringProperty(state.metadata, 'sessionId') as KiloSessionId | undefined;
  }
  return undefined;
}

export function getChildSessionStreaming(
  messages: StoredMessage[],
  childSessionId: KiloSessionId
): boolean {
  for (const message of messages) {
    if (message.info.role === 'assistant') {
      for (const part of message.parts) {
        if (
          isToolPart(part) &&
          part.tool === 'task' &&
          part.state.status === 'running' &&
          getTaskToolSessionId(part) === childSessionId
        ) {
          return true;
        }
      }
    }
  }
  return false;
}
