import 'server-only';
import { TRPCError } from '@trpc/server';
import {
  INTERNAL_API_SECRET,
  SECURITY_SYNC_WORKER_URL,
} from '@kilocode/web-shared/lib/config.server';
import { postSecurityWorkerJson } from './security-worker-request';

export type AcceptedSecurityWorkerCommand = {
  accepted: true;
  commandId: string;
  runId: string;
  messageId: string;
};

type SecurityWorkerResponse = {
  success?: boolean;
  accepted?: boolean;
  commandId?: string;
  runId?: string;
  messageId?: string;
  error?: string;
};

// Mirrored by the mobile security mutation classifier: a stable non-retryable
// code, not the generic 500 the classifier treats as retryable transport.
const CONFIG_ERROR_MESSAGE = 'Security service is not configured';

/**
 * Posts a security-sync Worker command and classifies the outcome for the
 * operation ledger: `BAD_GATEWAY` is ambiguous transport (the Worker may still
 * have accepted), `PRECONDITION_FAILED` is a definitive pre-acceptance
 * rejection. Worker/gateway response bodies are never echoed back.
 *
 * The call is bounded by `postSecurityWorkerJson`, so a Worker that never
 * answers fails fast instead of holding the request open.
 */
export async function postSecurityWorkerCommand(params: {
  path: string;
  /** Service name used in the client-facing messages. */
  service: 'sync' | 'dismissal';
  /** The Worker's known pre-enqueue disabled-routing error body (a 503). */
  disabledRoutingError: string;
  body: Record<string, unknown>;
}): Promise<AcceptedSecurityWorkerCommand> {
  if (!SECURITY_SYNC_WORKER_URL || !INTERNAL_API_SECRET) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: CONFIG_ERROR_MESSAGE });
  }
  // Bounded, and `BAD_GATEWAY` on a stalled or non-JSON response (see
  // `postSecurityWorkerJson`): a gateway HTML body and a Worker that never
  // answers both leave the command's acceptance unknown.
  const { response, body } = await postSecurityWorkerJson({
    url: `${SECURITY_SYNC_WORKER_URL}${params.path}`,
    service: params.service,
    body: params.body,
  });
  const workerBody = body as SecurityWorkerResponse | undefined;

  if (!response.ok) {
    const failed = `Security ${params.service} service request failed (status ${response.status}).`;
    // The known disabled-routing 503 is returned before enqueueing, so it is a
    // definitive rejection. Any other 5xx (including a gateway 503) may have
    // been accepted and stays ambiguous transport.
    const definitive =
      response.status < 500 ||
      (response.status === 503 &&
        workerBody?.success === false &&
        workerBody?.error === params.disabledRoutingError);
    throw new TRPCError({
      code: definitive ? 'PRECONDITION_FAILED' : 'BAD_GATEWAY',
      message: definitive ? failed : `${failed} Try again.`,
    });
  }

  if (
    !workerBody ||
    workerBody.success !== true ||
    workerBody.accepted !== true ||
    typeof workerBody.commandId !== 'string' ||
    typeof workerBody.runId !== 'string' ||
    typeof workerBody.messageId !== 'string'
  ) {
    // Accepted, but the correlation ids were lost: the provider reference
    // cannot be recorded, so the outcome is ambiguous.
    throw new TRPCError({
      code: 'BAD_GATEWAY',
      message: `Security ${params.service} service returned an unexpected response. Try again.`,
    });
  }

  return {
    accepted: true,
    commandId: workerBody.commandId,
    runId: workerBody.runId,
    messageId: workerBody.messageId,
  };
}
