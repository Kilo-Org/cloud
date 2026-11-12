import { z } from 'zod';
import {
  cloudMessageInfoSchema,
  cloudMessagePartSchema,
  type MessageInfo,
  type Part,
} from '@kilocode/cloud-agent-sdk';

import { sortSessionMessagesForDisplay } from '@/lib/cloud-agent-next/message-ordering';

/** One message of a public share snapshot, in the shape the transcript renders. */
export type SharedTranscriptMessage = { info: MessageInfo; parts: Part[] };

const SnapshotMessageSchema = z.object({
  info: z.unknown(),
  parts: z.array(z.unknown()),
});

/**
 * Turn a public share snapshot's messages into renderable transcript messages.
 *
 * The snapshot is raw stored session data, so every message and every part is
 * validated at this boundary instead of being trusted by shape:
 * - a message whose info is not a stored user or assistant message is dropped —
 *   it has no bubble to render in;
 * - a part the SDK's boundary does not understand is dropped on its own, so one
 *   unreadable part never hides the rest of the message;
 * - the survivors are put in display order, because the export streams in
 *   ingest order (see `sortSessionMessagesForDisplay`), which differs from
 *   conversation order when a session is re-ingested.
 *
 * Returns an empty list for a session with no messages; the caller renders that
 * as the empty transcript, not as a failure.
 */
export function toSharedTranscriptMessages(
  rawMessages: readonly unknown[]
): SharedTranscriptMessage[] {
  const messages: SharedTranscriptMessage[] = [];
  for (const rawMessage of rawMessages) {
    const envelope = SnapshotMessageSchema.safeParse(rawMessage);
    if (!envelope.success) {
      continue;
    }
    const info = cloudMessageInfoSchema.safeParse(envelope.data.info);
    if (!info.success) {
      continue;
    }
    const parts: Part[] = [];
    for (const rawPart of envelope.data.parts) {
      const part = cloudMessagePartSchema.safeParse(rawPart);
      if (part.success) {
        parts.push(part.data);
      }
    }
    messages.push({ info: info.data, parts });
  }
  return sortSessionMessagesForDisplay(messages);
}
