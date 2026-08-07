import type { Part, StoredMessage } from '@kilocode/cloud-agent-sdk';
import type { GroupedConversationItem } from '@/src/shared/agent-conversation';
import { getToolImage } from '@/src/shared/agent-tool-images';

/** CLI snapshot-init progress injected as a synthetic text part.
 *  Extension-owned mirror of `apps/mobile/src/components/agents/part-types.ts:15`. */
export const isSnapshotProgressPart = (part: Part): boolean =>
  part.type === 'text' && part.synthetic === true && part.text.includes('Initializing snapshot');

/** True while this assistant message is still producing output. */
export const isMessageStreaming = (message: StoredMessage): boolean =>
  message.info.role === 'assistant' &&
  message.info.time.completed === undefined &&
  !message.info.error;

/** True when every part is the hidden synthetic snapshot progress, so the
 *  message shows no live output while it streams. */
export const isSnapshotOnlyMessage = (message: StoredMessage): boolean =>
  message.parts.length > 0 && message.parts.every(part => isSnapshotProgressPart(part));

/**
 * True when the agent is running but the newest message shows no live
 * assistant output — the gap between sending a prompt and the first
 * assistant token. A streaming message with only the hidden synthetic
 * snapshot progress also shows no live output. The indicator fills the gap.
 */
export const shouldShowWorkingIndicator = (
  isStreaming: boolean,
  messages: StoredMessage[]
): boolean => {
  if (!isStreaming) {
    return false;
  }
  const last = messages.at(-1);
  if (last === undefined) {
    return true;
  }
  return !isMessageStreaming(last) || isSnapshotOnlyMessage(last);
};

const buildToolExchange = (
  part: Extract<Part, { type: 'tool' }>
): Extract<GroupedConversationItem, { readonly type: 'tool-exchange' }> => {
  const toolCall = {
    arguments: part.state.input,
    id: part.id,
    name: part.tool,
    source: 'agent' as const,
    ...('title' in part.state && part.state.title !== undefined ? { title: part.state.title } : {}),
    type: 'tool-call' as const,
  };

  if (part.state.status === 'pending' || part.state.status === 'running') {
    return { toolCall, type: 'tool-exchange' };
  }

  if (part.state.status === 'error') {
    return {
      result: {
        error: part.state.error,
        id: `${part.id}-result`,
        ok: false,
        toolCallId: part.id,
        type: 'tool-result',
      },
      toolCall,
      type: 'tool-exchange',
    };
  }

  const imageDataUrl = getToolImage(part.id);
  return {
    result: {
      id: `${part.id}-result`,
      ok: true,
      toolCallId: part.id,
      type: 'tool-result',
      value: part.state.output,
      ...(imageDataUrl === undefined ? {} : { imageDataUrl }),
    },
    toolCall,
    type: 'tool-exchange',
  };
};

const toConversationItem = (
  message: StoredMessage,
  part: Part
): GroupedConversationItem | undefined => {
  if (part.type === 'text') {
    if (isSnapshotProgressPart(part) || part.text.trim() === '') {
      return undefined;
    }
    return {
      event: { id: part.id, role: message.info.role, text: part.text, type: 'message' },
      type: 'event',
    };
  }

  if (part.type === 'reasoning') {
    if (part.text.trim() === '') {
      return undefined;
    }
    return {
      event: { id: part.id, text: part.text, type: 'thinking' },
      type: 'event',
    };
  }

  if (part.type === 'tool') {
    return buildToolExchange(part);
  }

  return undefined;
};

/**
 * Map stored agent messages to the shared conversation items the browser
 * renderer consumes. Parts keep their stored order within each message.
 */
export const toAgentConversationItems = (messages: StoredMessage[]): GroupedConversationItem[] => {
  const items: GroupedConversationItem[] = [];

  for (const message of messages) {
    for (const part of message.parts) {
      const item = toConversationItem(message, part);
      if (item !== undefined) {
        items.push(item);
      }
    }
  }

  return items;
};

/**
 * Id of the last text part of the last message still streaming. Feeds
 * `ConversationList`'s `streamingMessageId`, which force-expands code blocks
 * while they stream. `undefined` when no assistant message is live.
 */
export const getStreamingTextPartId = (messages: StoredMessage[]): string | undefined => {
  for (const message of messages.toReversed()) {
    if (isMessageStreaming(message)) {
      const textPart = message.parts
        .toReversed()
        .find(part => part.type === 'text' && !isSnapshotProgressPart(part));
      return textPart?.id;
    }
  }
  return undefined;
};
