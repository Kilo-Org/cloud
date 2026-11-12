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
 * A stored part is persisted under `id` + `messageID` only — the ingest seam and
 * the Durable Object's part reader accept exactly that pair, and `sessionID` is
 * written by the live stream, not by the snapshot
 * (`persistedSdkPartIdentitySchema` in the session-ingest contract). The public
 * web page keeps such a part as-is, so the mobile viewer fills the message's own
 * `sessionID` in before validation rather than dropping a part the web page
 * renders.
 */
function withMessageSessionId(rawPart: unknown, sessionID: string): unknown {
  if (typeof rawPart !== 'object' || rawPart === null || 'sessionID' in rawPart) {
    return rawPart;
  }
  return { ...rawPart, sessionID };
}

/**
 * Turn a public share snapshot's messages into renderable transcript messages.
 *
 * The snapshot is raw stored session data, so every message and every part is
 * validated at this boundary instead of being trusted by shape:
 * - a message whose info is not a stored user or assistant message is dropped —
 *   it has no bubble to render in;
 * - a stored part that omits `sessionID` is completed from its message first, so
 *   the SDK schema reads the identity the ingest seam persisted;
 * - a part the SDK's boundary still does not understand is dropped on its own,
 *   so one unreadable part never hides the rest of the message;
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
      const part = cloudMessagePartSchema.safeParse(
        withMessageSessionId(rawPart, info.data.sessionID)
      );
      if (part.success) {
        parts.push(part.data);
      }
    }
    messages.push({ info: info.data, parts });
  }
  return sortSessionMessagesForDisplay(messages);
}
