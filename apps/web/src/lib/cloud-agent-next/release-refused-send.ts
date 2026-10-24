import { TRPCClientError } from '@trpc/client';
import {
  releaseUnadmittedUploads,
  type DispatchAttachments,
} from '@/lib/r2/cloud-agent-pending-uploads';

/** The http status the worker answered a send with, when it answered at all. */
export function workerRefusalStatus(error: unknown): number | undefined {
  if (!(error instanceof TRPCClientError)) return undefined;
  const status = (error.data as { httpStatus?: unknown } | undefined)?.httpStatus;
  return typeof status === 'number' ? status : undefined;
}

export type RefusedSend = {
  attachments: DispatchAttachments | undefined;
  error: unknown;
  kiloUserId: string;
  /** The object keys this dispatch's link moved to 'linked'. */
  linkedObjectKeys: string[];
};

type ReleaseDependencies = {
  release?: (
    kiloUserId: string,
    messageUuid: string,
    linkedObjectKeys: string[]
  ) => Promise<number>;
};

/**
 * Give back the attachment rows of a send the worker refused.
 *
 * A refusal is the worker's own error response to this send, received here, so
 * the turn was answered and not admitted: the worker refuses before it admits,
 * and an admitted send answers with a queued result. A transport failure, a
 * timeout or a server-side status proves nothing, so those keep the rows linked;
 * the same holds for a send this request never linked anything for, which is the
 * retry of a message an earlier dispatch already holds.
 *
 * The send's own error is what the caller reports; this helper never throws.
 */
export async function releaseRefusedSend(
  input: RefusedSend,
  { release = releaseUnadmittedUploads }: ReleaseDependencies = {}
): Promise<void> {
  const { attachments, error, kiloUserId, linkedObjectKeys } = input;
  const status = workerRefusalStatus(error);
  if (status === undefined || status < 400 || status >= 500) return;
  if (!attachments || linkedObjectKeys.length === 0) return;

  try {
    const released = await release(kiloUserId, attachments.path, linkedObjectKeys);
    if (released > 0) {
      console.info('[cloud-agent] Returned the attachments of a refused send', { released });
    }
  } catch (error) {
    console.error('[cloud-agent] Could not return the attachments of a refused send', error);
  }
}
