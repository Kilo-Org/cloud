import type { CloudAgentNextClient } from './cloud-agent-client';
import {
  releaseUnadmittedUploads,
  type DispatchAttachments,
} from '@/lib/r2/cloud-agent-pending-uploads';

/** Time between the first lookup and its confirmation. */
const confirmationDelayMs = 1_000;

type MessageResultLookup = Pick<CloudAgentNextClient, 'getMessageResult'>;

export type UnadmittedSend = {
  attachments: DispatchAttachments | undefined;
  client: MessageResultLookup;
  cloudAgentSessionId: string;
  kiloUserId: string;
  messageId: string;
};

type ReleaseDependencies = {
  delay?: (milliseconds: number) => Promise<void>;
  release?: (kiloUserId: string, attachments: DispatchAttachments) => Promise<number>;
};

const sleep = (milliseconds: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
};

/**
 * Give a failed send's attachment rows back to the abandoned-upload lifecycle,
 * but only when the worker states that it never admitted the turn.
 *
 * The worker records an admitted message before it answers the send, and its
 * session object serves one request at a time, so a lookup that still reports
 * no such message is a statement that the turn did not happen. The lookup runs
 * twice, one confirmation apart, because a send that failed in transport can
 * still be on its way. Every other answer keeps the rows linked: a message the
 * worker holds must never lose its attachments, and an unavailable lookup is
 * not proof that the turn was refused.
 *
 * The send's own error is what the caller reports; this helper never throws.
 */
export async function releaseUnadmittedSend(
  input: UnadmittedSend,
  { delay = sleep, release = releaseUnadmittedUploads }: ReleaseDependencies = {}
): Promise<void> {
  const { attachments, client, cloudAgentSessionId, kiloUserId, messageId } = input;
  if (!attachments || attachments.files.length === 0) return;

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) await delay(confirmationDelayMs);
      const result = await client.getMessageResult({ cloudAgentSessionId, messageId });
      if (result !== null) return;
    }
  } catch (error) {
    console.error('[cloud-agent] Could not confirm a failed send was not admitted', error);
    return;
  }

  try {
    const released = await release(kiloUserId, attachments);
    if (released > 0) {
      console.info('[cloud-agent] Returned the attachments of an unadmitted send', { released });
    }
  } catch (error) {
    console.error('[cloud-agent] Could not return the attachments of an unadmitted send', error);
  }
}
