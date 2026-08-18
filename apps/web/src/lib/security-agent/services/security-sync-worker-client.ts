import 'server-only';
import { TRPCError } from '@trpc/server';
import { INTERNAL_API_SECRET, SECURITY_SYNC_WORKER_URL } from '@/lib/config.server';

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
  const unreachable = new TRPCError({
    code: 'BAD_GATEWAY',
    message: `Could not reach the security ${params.service} service. Try again.`,
  });

  let response: Response;
  let body: SecurityWorkerResponse | undefined;
  try {
    response = await fetch(`${SECURITY_SYNC_WORKER_URL}${params.path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-api-key': INTERNAL_API_SECRET,
      },
      body: JSON.stringify(params.body),
    });
    // A non-JSON body (gateway HTML) leaves the acceptance unknown.
    body = (await response.json()) as SecurityWorkerResponse;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw unreachable;
  }

  if (!response.ok) {
    const failed = `Security ${params.service} service request failed (status ${response.status}).`;
    // The known disabled-routing 503 is returned before enqueueing, so it is a
    // definitive rejection. Any other 5xx (including a gateway 503) may have
    // been accepted and stays ambiguous transport.
    const definitive =
      response.status < 500 ||
      (response.status === 503 &&
        body?.success === false &&
        body?.error === params.disabledRoutingError);
    throw new TRPCError({
      code: definitive ? 'PRECONDITION_FAILED' : 'BAD_GATEWAY',
      message: definitive ? failed : `${failed} Try again.`,
    });
  }

  if (
    !body ||
    body.success !== true ||
    body.accepted !== true ||
    typeof body.commandId !== 'string' ||
    typeof body.runId !== 'string' ||
    typeof body.messageId !== 'string'
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
    commandId: body.commandId,
    runId: body.runId,
    messageId: body.messageId,
  };
}
