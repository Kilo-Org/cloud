import { type KiloSessionId, type Part, type StoredMessage, type ToolPart } from 'cloud-agent-sdk';

import { computeStatus } from './compute-status';
import { isToolPart } from './part-types';
import { getFilename, truncateText } from './tool-card-utils';

export type ChildSessionActivity = { tool: string; context?: string };

export type ChildSessionCardState = {
  agentName: string;
  taskName: string;
  latestActivity: ChildSessionActivity | string;
};

function getStringProperty(obj: unknown, key: string): string | undefined {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return undefined;
  }
  const value = (obj as Record<string, unknown>)[key];
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

function findLatestAssistantPart(messages: StoredMessage[]): Part | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.info.role === 'assistant') {
      for (let j = msg.parts.length - 1; j >= 0; j -= 1) {
        const part = msg.parts[j];
        if (part) {
          return part;
        }
      }
    }
  }
  return undefined;
}

export function getChildSessionCardState(
  part: ToolPart,
  childMessages: StoredMessage[]
): ChildSessionCardState {
  const input = part.state.input;
  const agentName = getStringProperty(input, 'subagent_type') ?? 'Subagent';
  const description = getStringProperty(input, 'description');
  const prompt = getStringProperty(input, 'prompt');
  const taskName = description ?? (prompt ? truncateText(prompt, 60) : 'Task');

  const latestPart = findLatestAssistantPart(childMessages);
  const latestActivity: ChildSessionActivity | string = (() => {
    if (!latestPart) {
      return 'Waiting for activity';
    }
    if (isToolPart(latestPart)) {
      return { tool: latestPart.tool, context: getToolContext(latestPart) };
    }
    return computeStatus(latestPart);
  })();

  return { agentName, taskName, latestActivity };
}

export function getChildSessionActivityLabel(activity: ChildSessionActivity | string): string {
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
