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
 * `CloudAgentBillingError`, and a non-JSON answer becomes a plain error whose
 * cause is the original. Those carry the status themselves or keep it on the
 * cause, so the status is read along that chain as well as from the tRPC shape.
 */
export function workerRefusalStatus(error: unknown): number | undefined {
  // The client wraps some answers and keeps the original as the cause, so the
  // status may sit one or two links down the chain.
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current === null || typeof current !== 'object') return undefined;

    const direct = (current as { httpStatus?: unknown }).httpStatus;
    if (typeof direct === 'number') return direct;

    if (current instanceof TRPCClientError) {
      const data = current.data as { httpStatus?: unknown } | undefined;
      const shapeData = current.shape?.data as { httpStatus?: unknown } | undefined;
      const status = data?.httpStatus ?? shapeData?.httpStatus;
      if (typeof status === 'number') return status;
    }

    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * The worker statuses that prove it refused this send before admitting it.
 *
 * `services/cloud-agent-next/src/trpc-error.ts` maps the worker's answers to a
 * status. 408 TIMEOUT and 499 CLIENT_CLOSED_REQUEST are in that map but say
 * nothing about admission, and neither does any server-side status, so they are
 * absent here along with every status the map does not name.
 *
 * The residual error is deliberately one-sided: a refusal left out of this set
 * leaves a 'linked' row the reaper never claims, while releasing the rows of a
 * turn the worker did admit lets the reaper delete objects that turn still
 * references.
 */
const REFUSAL_STATUSES: ReadonlySet<number> = new Set([
  400, 401, 402, 403, 404, 405, 409, 412, 413, 415, 422, 429,
]);

/** Whether this send failed with a worker answer that proves no turn exists. */
export function refusedBeforeAdmission(status: number | undefined): boolean {
  return status !== undefined && REFUSAL_STATUSES.has(status);
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
 * A refusal is an answer that proves the worker refused this send before it
 * admitted the turn, so an accepted turn never existed. A transport failure, a
 * timeout, a request the caller closed, or a server-side status proves nothing,
 * so those keep the rows linked; the same holds for a send that linked no rows
 * here, which is the retry of an attachment an earlier dispatch holds.
 *
 * The send's own error is what the caller reports; this helper never throws.
 */
export async function releaseRefusedSend(
  input: RefusedSend,
  { release = releaseUnadmittedUploads }: ReleaseDependencies = {}
): Promise<void> {
  const { attachments, error, kiloUserId, linkedObjectKeys } = input;
  if (!refusedBeforeAdmission(workerRefusalStatus(error))) return;
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
