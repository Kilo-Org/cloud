import type { ThreadMessageLike } from '@assistant-ui/react';
import type { PreparationAttempt, SessionCommit } from '@kilocode/cloud-agent-sdk';
import { isAssistantInterruptError } from '../message-error';
import { getVisibleAssistantParts, groupConversationMessages } from '../message-presentation';
import { isMessageStreaming, isPartStreaming, type Part, type StoredMessage } from '../types';
import { groupAssistantParts } from '../shared-transcript-presentation';
import { reconcileGroupIdentities } from './group-identity';
import type {
  CloudMessagePresentation,
  CloudProjectedMessage,
  CloudProjectionInput,
} from './presentation-types';

const noPreparations: ReadonlyMap<string, readonly PreparationAttempt[]> = new Map();
const noCommits: ReadonlyMap<string, readonly SessionCommit[]> = new Map();
const emptyPreparations: readonly PreparationAttempt[] = [];
const emptyCommits: readonly SessionCommit[] = [];
type ContentPart = Exclude<ThreadMessageLike['content'], string>[number];

function projectPart(part: Part, streaming: boolean): ContentPart {
  switch (part.type) {
    case 'text':
    case 'reasoning':
      return {
        type: part.type,
        id: part.id,
        text: part.text,
        status: { type: streaming && isPartStreaming(part) ? 'running' : 'complete' },
      };
    case 'tool':
      return {
        type: 'tool-call',
        toolCallId: part.callID,
        toolName: part.tool,
        // The SDK allows non-JSON values in input. The original typed input and
        // structured output stay in presentation.parts instead of a lossy JSON cast.
        argsText:
          part.state.status === 'pending' ? part.state.raw : JSON.stringify(part.state.input),
        ...(part.state.status === 'completed'
          ? {
              result: {
                output: part.state.output,
                metadata: part.state.metadata,
                attachments: part.state.attachments,
              },
            }
          : part.state.status === 'error'
            ? { result: { error: part.state.error, metadata: part.state.metadata }, isError: true }
            : {}),
      };
    default:
      // Files include stripped URLs and Cloud-specific rendering rules. Data
      // parts preserve these records without upstream URL sanitization or uploads.
      return { type: 'data', id: part.id, name: 'cloud-part', data: part };
  }
}

function messageStatus(last: StoredMessage, streaming: boolean): ThreadMessageLike['status'] {
  if (last.info.role !== 'assistant') return undefined;
  if (last.info.error) {
    return {
      type: 'incomplete',
      reason: isAssistantInterruptError(last.info.error) ? 'cancelled' : 'error',
    };
  }
  return streaming ? { type: 'running' } : { type: 'complete', reason: 'stop' };
}

function sameSources(left: readonly StoredMessage[], right: readonly StoredMessage[]): boolean {
  return left.length === right.length && left.every((message, index) => message === right[index]);
}

/** One projector per transcript. Cache rows, never canonical SDK state. */
export function createCloudMessageProjector() {
  let previous = new Map<string, CloudProjectedMessage>();
  const partsCache = new WeakMap<Part, { streaming: boolean; content: ContentPart }>();

  return (input: CloudProjectionInput): readonly CloudProjectedMessage[] => {
    const preparations = input.preparationByMessageId ?? noPreparations;
    const commits = input.commitsAfterMessage ?? noCommits;
    const groups =
      input.messageGroups ?? groupConversationMessages([...input.messages], preparations, commits);
    const next = new Map<string, CloudProjectedMessage>();
    const rows: CloudProjectedMessage[] = [];
    const identities = reconcileGroupIdentities(
      groups.map(sources => sources.map(source => source.info.id)),
      [...previous].map(([id, row]) => ({ id, itemIds: row.presentation.messageIds }))
    );

    for (const [index, sources] of groups.entries()) {
      const first = sources[0];
      const last = sources.at(-1);
      if (!first || !last) continue;
      const streaming = input.isStreaming && isMessageStreaming(last);
      const deliveryState = input.pendingMessages?.get(first.info.id);
      const isSending = input.sendingMessageIds?.has(first.info.id) ?? false;
      const anchoredPreparations = preparations.get(first.info.id) ?? emptyPreparations;
      const anchoredCommits = commits.get(last.info.id) ?? emptyCommits;
      const id = identities[index]?.id ?? first.info.id;
      const cached = previous.get(id);
      const old = cached?.presentation;
      if (
        cached &&
        old &&
        sameSources(old.sources, sources) &&
        old.isStreaming === streaming &&
        old.deliveryState === deliveryState &&
        old.isSending === isSending &&
        old.preparations === anchoredPreparations &&
        old.commits === anchoredCommits
      ) {
        rows.push(cached);
        next.set(id, cached);
        continue;
      }

      const parts = sources.flatMap(source =>
        source.parts.map(part => ({
          id: part.id,
          messageId: source.info.id,
          source: part,
          ...(part.type === 'tool' ? { toolCallId: part.callID } : {}),
        }))
      );
      const sourceParts = parts.map(part => part.source);
      const visible =
        first.info.role === 'assistant' ? getVisibleAssistantParts(sourceParts) : sourceParts;
      const segments = groupAssistantParts(visible, 'live');
      const segmentIds = reconcileGroupIdentities(
        segments.map(segment => segment.parts.map(part => part.id)),
        old?.segments.map(segment => ({
          id: segment.id,
          itemIds: segment.parts.map(part => part.id),
        })) ?? []
      );
      const presentation: CloudMessagePresentation = {
        id: first.info.id,
        messageIds: sources.map(source => source.info.id),
        sources,
        parts,
        segments: segments.map((segment, index) => ({
          ...segment,
          id: segmentIds[index]?.id ?? '',
        })),
        displayTimestamp: last.info.time.created,
        isStreaming: streaming,
        deliveryState,
        isSending,
        preparations: anchoredPreparations,
        commits: anchoredCommits,
      };
      const content = visible.map(part => {
        const partStreaming = streaming && isPartStreaming(part);
        const cachedPart = partsCache.get(part);
        if (cachedPart?.streaming === partStreaming) return cachedPart.content;
        const content = projectPart(part, partStreaming);
        partsCache.set(part, { streaming: partStreaming, content });
        return content;
      });
      const row: CloudProjectedMessage = {
        presentation,
        message: {
          id,
          role: first.info.role,
          createdAt: new Date(last.info.time.created),
          content,
          status: messageStatus(last, streaming),
          metadata: { custom: { cloud: presentation } },
        },
      };
      rows.push(row);
      next.set(id, row);
    }
    previous = next;
    return rows;
  };
}
