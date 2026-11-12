import {
  kilo2ConversationMessageSchema,
  sessionIdSchema,
} from '@kilocode/session-ingest-contracts';
import { z } from 'zod';
import { projectKilo2MessageForDisplay } from '../../shared/tool-display-projection.js';
import { readConversationSource } from './conversation-history.js';
import type { SessionEventQueries } from './event-queries.js';
import { MAX_SESSION_PAGE_BYTES } from './history.js';
import { readNativeEventPayload } from './native-events.js';

/** Complete tool details never exceed the history page's hard cap. */
export const MAX_TOOL_DETAIL_BYTES = MAX_SESSION_PAGE_BYTES;

const nativeId = z.string().min(1).max(256);

export const toolPartDetailInputSchema = z
  .object({
    kiloSessionId: sessionIdSchema.optional(),
    expectedRootKiloSessionId: sessionIdSchema.optional(),
    messageId: nativeId,
    partId: nativeId,
    /** Native v2 tool entries are addressed by call ID inside their message. */
    callId: nativeId.optional(),
  })
  .strict();
export type ToolPartDetailInput = z.input<typeof toolPartDetailInputSchema>;

export type ToolPartDetail =
  | {
      kind: 'found';
      source: { version: 'v1' };
      revision: number;
      part: Record<string, unknown>;
    }
  | {
      kind: 'found';
      source: z.infer<typeof kilo2SourceSchema>;
      revision: number;
      message: Record<string, unknown>;
      parentID?: string;
    }
  | { kind: 'not_found' }
  | { kind: 'too_large'; bytes: number };

const kilo2SourceSchema = z.custom<NonNullable<ReturnType<typeof readConversationSource>>>();
const v1PartSchema = z
  .object({
    id: z.string(),
    sessionID: z.string(),
    messageID: z.string(),
    type: z.literal('tool'),
  })
  .passthrough();
const v1MessageInfoSchema = z.object({ id: z.string(), sessionID: z.string() }).passthrough();
const encoder = new TextEncoder();

function bounded(detail: Extract<ToolPartDetail, { kind: 'found' }>): ToolPartDetail {
  const bytes = encoder.encode(JSON.stringify(detail)).byteLength;
  return bytes > MAX_TOOL_DETAIL_BYTES ? { kind: 'too_large', bytes } : detail;
}

/**
 * Reads one complete stored tool call. The caller has already authorized the
 * workspace and the native session lineage; this read only checks that the
 * row belongs to that session and has not been removed. It never wakes compute.
 */
export function readToolPartDetail(input: {
  queries: SessionEventQueries;
  sessionId: string;
  kiloSessionId: string;
  messageId: string;
  partId: string;
  callId?: string;
}): ToolPartDetail {
  const { queries, sessionId, kiloSessionId, messageId } = input;
  const owned = (row: { session_id: string; mutation_cursor?: number | null } | null) =>
    row !== null && row.session_id === sessionId && row.mutation_cursor != null;
  const messageRow = queries.findByEntityId(`message/${messageId}`);
  if (!owned(messageRow) || messageRow === null) return { kind: 'not_found' };
  const messagePayload = readNativeEventPayload(messageRow.payload);

  const source = readConversationSource({ queries, kiloSessionId });
  if (source !== undefined) {
    if (input.callId === undefined || messagePayload?.type !== 'conversation.message.updated')
      return { kind: 'not_found' };
    const parsed = kilo2ConversationMessageSchema.safeParse(messagePayload.properties);
    if (
      !parsed.success ||
      parsed.data.sessionID !== kiloSessionId ||
      parsed.data.message.id !== messageId
    )
      return { kind: 'not_found' };
    const revision = messageRow.mutation_cursor ?? 0;
    const content = parsed.data.message.content ?? [];
    const index = content.findIndex(item => item.type === 'tool' && item.id === input.callId);
    if (index < 0) return { kind: 'not_found' };
    // Only the requested call is complete; sibling tools stay previews.
    const projected = projectKilo2MessageForDisplay(parsed.data.message, revision) as {
      content: unknown[];
    };
    const message = {
      ...projected,
      content: projected.content.map((item, position) =>
        position === index ? content[index] : item
      ),
    };
    return bounded({
      kind: 'found',
      source,
      revision,
      message,
      ...(parsed.data.parentID ? { parentID: parsed.data.parentID } : {}),
    });
  }

  if (messagePayload?.type !== 'message.updated') return { kind: 'not_found' };
  const info = v1MessageInfoSchema.safeParse(messagePayload.properties.info);
  if (!info.success || info.data.id !== messageId || info.data.sessionID !== kiloSessionId)
    return { kind: 'not_found' };
  const partRow = queries.findByEntityId(`part/${messageId}/${input.partId}`);
  if (!owned(partRow) || partRow === null) return { kind: 'not_found' };
  const partPayload = readNativeEventPayload(partRow.payload);
  if (partPayload?.type !== 'message.part.updated') return { kind: 'not_found' };
  const part = v1PartSchema.safeParse(partPayload.properties.part);
  if (
    !part.success ||
    part.data.id !== input.partId ||
    part.data.messageID !== messageId ||
    part.data.sessionID !== kiloSessionId
  )
    return { kind: 'not_found' };
  return bounded({
    kind: 'found',
    source: { version: 'v1' },
    revision: partRow.mutation_cursor ?? 0,
    part: part.data,
  });
}
