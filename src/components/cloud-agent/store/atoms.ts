/**
 * Cloud Agent Atoms
 *
 * Jotai atom definitions for cloud agent chat state management.
 * Influenced pretty heavily by the cli.
 */

import { atom } from 'jotai';
import type { CloudMessage, SessionConfig } from '../types';
import { splitByContiguousPrefix } from '@/lib/utils/splitByContiguousPrefix';

// Primary state
export const messagesAtom = atom<CloudMessage[]>([]);
export const messageVersionMapAtom = atom<Map<number, number>>(new Map());
export const streamingMessagesAtom = atom<Set<number>>(new Set<number>());
export const currentSessionIdAtom = atom<string | null>(null);
export const sessionConfigAtom = atom<SessionConfig | null>(null);
export const isStreamingAtom = atom(false);
export const errorAtom = atom<string | null>(null);
export const chatUIAtom = atom({
  shouldAutoScroll: true,
});

// Derived atoms
export const filteredMessagesAtom = atom(get => {
  const messages = get(messagesAtom);
  return messages.filter(msg => shouldDisplayMessage(msg));
});

const splitMessagesAtom = atom(get => {
  const messages = get(filteredMessagesAtom);
  return splitByContiguousPrefix(messages, isMessageComplete);
});

export const staticMessagesAtom = atom(get => get(splitMessagesAtom).staticItems);

export const dynamicMessagesAtom = atom(get => get(splitMessagesAtom).dynamicItems);

// Matches CLI's getApiMetrics logic
export const totalCostAtom = atom(get => {
  const messages = get(messagesAtom);
  let totalCost = 0;

  messages.forEach(message => {
    if (message.say === 'api_req_started' && message.metadata?.cost !== undefined) {
      totalCost += message.metadata.cost as number;
    }
    if (message.say === 'condense_context' && message.metadata?.cost !== undefined) {
      totalCost += message.metadata.cost as number;
    }
  });

  return totalCost;
});

// Write-only atoms (actions)
export const updateMessageAtom = atom(null, (get, set, updatedMessage: CloudMessage) => {
  const messages = get(messagesAtom);
  const versionMap = get(messageVersionMapAtom);
  const existingIndex = messages.findIndex(m => m.ts === updatedMessage.ts);

  if (existingIndex !== -1) {
    const existing = messages[existingIndex];
    const currentVersion = versionMap.get(existing.ts) || 0;
    const newVersion = getMessageContentLength(updatedMessage);
    const partialChanged = existing.partial !== updatedMessage.partial;

    if (updatedMessage.partial || newVersion > currentVersion || partialChanged) {
      const newMessages = [...messages];
      newMessages[existingIndex] = updatedMessage;
      set(messagesAtom, newMessages);

      const newVersionMap = new Map(versionMap);
      newVersionMap.set(updatedMessage.ts, newVersion);
      set(messageVersionMapAtom, newVersionMap);

      const streamingSet = new Set(get(streamingMessagesAtom));
      if (updatedMessage.partial) {
        streamingSet.add(updatedMessage.ts);
      } else {
        streamingSet.delete(updatedMessage.ts);
      }
      set(streamingMessagesAtom, streamingSet);
    }
  } else {
    const newMessages = [...messages, updatedMessage];
    set(messagesAtom, newMessages);

    const newVersionMap = new Map(versionMap);
    newVersionMap.set(updatedMessage.ts, getMessageContentLength(updatedMessage));
    set(messageVersionMapAtom, newVersionMap);

    if (updatedMessage.partial) {
      const streamingSet = new Set(get(streamingMessagesAtom));
      streamingSet.add(updatedMessage.ts);
      set(streamingMessagesAtom, streamingSet);
    }
  }
});

export const addUserMessageAtom = atom(null, (get, set, content: string) => {
  const userMessage: CloudMessage = {
    ts: Date.now(),
    type: 'user',
    text: content,
    partial: false,
  };
  set(updateMessageAtom, userMessage);
});

export const clearMessagesAtom = atom(null, (get, set) => {
  set(messagesAtom, []);
  set(messageVersionMapAtom, new Map());
  set(streamingMessagesAtom, new Set());
  set(isStreamingAtom, false);
  set(currentSessionIdAtom, null);
  set(errorAtom, null);
});

// Helper functions
function getMessageContentLength(message: CloudMessage): number {
  if (message.say === 'api_req_started') {
    const metadata = message.metadata || {};
    return metadata.cost !== undefined ? 1 : 0;
  }
  return message.text?.length || message.content?.length || 0;
}

function shouldDisplayMessage(message: CloudMessage): boolean {
  if (message.say === 'checkpoint_saved') {
    return false;
  }

  if (message.ask === 'completion_result' || message.ask === 'command_output') {
    return false;
  }

  if (message.say === 'command_output') {
    const content = message.text || message.content || '';
    return content.trim().length > 0;
  }

  // Matching CLI behavior
  if (message.ask === 'command') {
    return true;
  }

  if (message.ask === 'tool' || message.ask === 'use_mcp_tool') {
    const hasContent = !!(message.text || message.content);
    const isStreaming = message.partial === true;
    const hasMetadata = !!message.metadata && Object.keys(message.metadata).length > 0;
    return hasContent || isStreaming || hasMetadata;
  }

  const content = message.text || message.content || '';
  const hasRealContent = content.trim().length > 0 || message.metadata;

  if (!hasRealContent && message.say !== 'api_req_started') {
    return false;
  }

  return true;
}

// Based on CLI's isExtensionMessageComplete logic
function isMessageComplete(message: CloudMessage): boolean {
  if (message.partial === true) {
    return false;
  }

  if (message.say === 'api_req_started') {
    try {
      const metadata = message.metadata || JSON.parse(message.text || '{}');
      return !!(
        metadata.streamingFailedMessage ||
        metadata.cancelReason ||
        metadata.cost !== undefined
      );
    } catch {
      return false;
    }
  }

  if (message.ask === 'tool' || message.ask === 'use_mcp_tool' || message.ask === 'command') {
    return message.partial === false;
  }

  if (message.type === 'system') {
    return true;
  }

  return !message.partial;
}
