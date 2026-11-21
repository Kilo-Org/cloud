import { readKilo2Messages } from '@kilocode/cloud-agent-sdk/kilo2-source-messages';
import {
  kilo2ConversationSourceSchema,
  kilo2MessageSchema,
  kiloSdkStoredMessageSchema,
  type KiloSdkStoredMessage,
} from '@kilocode/session-ingest-contracts';
import { z } from 'zod';
import { decodeSessionHistoryCursor } from '../control-plane/session/history.js';
import type { GetCloudAgentRootSessionMessagesParams } from '../session-ingest-binding.js';
import type { Env } from '../types.js';
import { getSandboxSessionStub } from '../sandbox-session/session-stub.js';
import { withDORetry } from '../utils/do-retry.js';
import { projectPublicStoredMessages } from './public-sdk-projection.js';

const MAX_PUBLIC_HISTORY_BYTES = 8 * 1024 * 1024;
const MAX_PUBLIC_HISTORY_PAGES = 100;
const v2HistoryPageSchema = z.object({
  source: kilo2ConversationSourceSchema,
  messages: z.array(z.object({ message: kilo2MessageSchema, parentID: z.string().optional() })),
  nextCursor: z.string().nullable(),
  omittedItemCount: z.number().int().nonnegative(),
});

type HistoryRequest = {
  env: Env;
  userId: string;
  kiloSessionId: string;
  cloudAgentSessionId: string;
  query: Pick<GetCloudAgentRootSessionMessagesParams, 'limit' | 'before'>;
};

export function validatePublicV2HistoryCursor(input: HistoryRequest): boolean {
  if (input.query.before === undefined) return true;
  try {
    const cursor = decodeSessionHistoryCursor(input.query.before);
    return (
      cursor.sessionId === input.cloudAgentSessionId &&
      cursor.rootKiloSessionId === input.kiloSessionId &&
      cursor.kiloSessionId === input.kiloSessionId
    );
  } catch {
    return false;
  }
}

type HistoryResult =
  | { kind: 'not_found' | 'retryable_failure' | 'invalid_data' | 'too_large' }
  | {
      kind: 'success';
      messages: KiloSdkStoredMessage[];
      nextCursor: string | null;
      omittedItemCount: number;
    };

export async function readPublicV2History(input: HistoryRequest): Promise<HistoryResult> {
  const bounded = input.query.limit !== undefined && input.query.limit > 0;
  let cursor = input.query.before;
  let omittedItemCount = 0;
  let displayOmissionCount = 0;
  let bytes = 2;
  const messages: KiloSdkStoredMessage[] = [];
  for (let pageIndex = 0; pageIndex < MAX_PUBLIC_HISTORY_PAGES; pageIndex++) {
    let rawPage: unknown;
    try {
      rawPage = await withDORetry(
        () => getSandboxSessionStub(input.env, input.userId, input.cloudAgentSessionId),
        async (stub): Promise<unknown> =>
          stub.getSessionMessagesPage({
            expectedRootKiloSessionId: input.kiloSessionId,
            kiloSessionId: input.kiloSessionId,
            cursor,
            limit: bounded ? input.query.limit : 100,
            toolDisplay: 'full',
          }),
        'getSessionMessagesPage'
      );
    } catch {
      return { kind: 'retryable_failure' };
    }
    if (rawPage === null) return { kind: 'not_found' };
    const parsed = v2HistoryPageSchema.safeParse(rawPage);
    if (!parsed.success || parsed.data.source.session.id !== input.kiloSessionId)
      return { kind: 'invalid_data' };
    const page = parsed.data;
    const projected: KiloSdkStoredMessage[] = [];
    try {
      for (const item of page.messages) {
        const display = readKilo2Messages(page.source.session, [item.message])[0];
        if (display === undefined) {
          if (item.message.type !== 'compaction' && item.message.type !== 'shell')
            displayOmissionCount++;
          continue;
        }
        if (display.info.role === 'assistant' && item.parentID !== undefined)
          display.info.parentID = item.parentID;
        projected.push(kiloSdkStoredMessageSchema.parse(display));
      }
    } catch {
      return { kind: 'invalid_data' };
    }
    const publicMessages = projectPublicStoredMessages(projected, input.kiloSessionId);
    bytes += new TextEncoder().encode(JSON.stringify(publicMessages)).byteLength;
    if (bytes > MAX_PUBLIC_HISTORY_BYTES) return { kind: 'too_large' };
    messages.unshift(...publicMessages);
    omittedItemCount += page.omittedItemCount;
    if (bounded || page.nextCursor === null) {
      if (messages.length === 0 && omittedItemCount > 0) return { kind: 'too_large' };
      return {
        kind: 'success',
        messages,
        nextCursor: page.nextCursor,
        omittedItemCount: omittedItemCount + displayOmissionCount,
      };
    }
    if (page.nextCursor === cursor) return { kind: 'invalid_data' };
    cursor = page.nextCursor;
  }
  return { kind: 'too_large' };
}
