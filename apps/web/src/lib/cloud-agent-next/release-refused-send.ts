import { TRPCClientError } from '@trpc/client';
import {
  releaseUnadmittedUploads,
  type DispatchAttachments,
} from '@/lib/r2/cloud-agent-pending-uploads';

/**
 * The http status a send failure carries, when the worker answered it.
 *
 * `client.sendMessage` rewrites several worker answers before this sees them: a
 * credits refusal becomes `InsufficientCreditsError`, a billing refusal becomes
 * `CloudAgentBillingError`, and those carry `httpStatus` themselves instead of
 * the tRPC shape.
 */
export function workerRefusalStatus(error: unknown): number | undefined {
  const direct = (error as { httpStatus?: unknown } | null | undefined)?.httpStatus;
  if (typeof direct === 'number') return direct;

  if (error instanceof TRPCClientError) {
    const data = error.data as { httpStatus?: unknown } | undefined;
    const shapeData = error.shape?.data as { httpStatus?: unknown } | undefined;
    const status = data?.httpStatus ?? shapeData?.httpStatus;
    return typeof status === 'number' ? status : undefined;
  }

  return undefined;
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
 * A refusal is a 4xx answer to this send: the worker refuses before it admits,
 * and an admitted send answers with a queued result, so a refused turn never
 * existed. A transport failure, a timeout or a server-side status proves
 * nothing, so those keep the rows linked; the same holds for a send that linked
 * no rows here, which is the retry of an attachment an earlier dispatch holds.
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
