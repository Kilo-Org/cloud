import 'server-only';
import { TRPCError } from '@trpc/server';
import { SECURITY_AUTO_ANALYSIS_WORKER_URL } from '@kilocode/web-shared/lib/config.server';
import { readInternalApiSecret } from '@kilocode/web-shared/lib/internal-api-secret';
import {
  isDefinitiveSecurityWorkerRejection,
  postSecurityWorkerJson,
} from './security-worker-request';
import {
  SECURITY_ANALYSIS_REJECTED_MESSAGE,
  SECURITY_SERVICE_NOT_CONFIGURED_MESSAGE,
} from '@kilocode/app-shared/security-agent';
import type { SecurityReviewOwner } from '../core/types';

type ManualAnalysisStartParams = {
  findingId: string;
  owner: SecurityReviewOwner;
  actorUserId: string;
  requestedModels?: {
    model?: string;
    triageModel?: string;
    analysisModel?: string;
  };
  forceSandbox?: boolean;
  retrySandboxOnly?: boolean;
  restartActive?: boolean;
};

type ManualAnalysisResponse = {
  success?: boolean;
  accepted?: boolean;
  commandId?: string;
  error?: string;
};

/**
 * The Worker's known pre-enqueue disabled-routing error body (a 503, returned
 * before the command row is created), which is therefore a definitive
 * rejection rather than ambiguous transport.
 */
const DISABLED_ROUTING_ERROR = 'Manual analysis Worker routing is disabled';

/**
 * Logs a definitive Worker rejection before it becomes the stable client
 * error: the status is what separates an internal-secret mismatch (401) or a
 * request-schema drift (400) from a policy rejection (409) once the body is no
 * longer echoed. The Worker's `error` body is notes-only and length-capped.
 *
 * Rejection classes at the throw sites: an auth/config rejection (401/403)
 * means the deployment is misconfigured, so the client gets the
 * service-not-configured sentence (`SECURITY_SERVICE_NOT_CONFIGURED_MESSAGE`).
 * Any other rejection keeps the analysis-rejection sentence. Both go out as
 * `PRECONDITION_FAILED`; the sentences are shared with the mobile ledger
 * (stable-error-messages).
 */
function logDefinitiveRejection(route: string, status: number, body: unknown): void {
  let notes: string | null = null;
  if (body !== null && typeof body === 'object' && 'error' in body) {
    const raw = body.error;
    if (typeof raw === 'string') {
      notes = raw.slice(0, 200);
    }
  }
  console.error('Security analysis Worker rejected the request', {
    route,
    status,
    ...(notes !== null ? { notes } : {}),
  });
}

/**
 * The stable error for a definitive Worker rejection: a 401/403 is the Worker
 * refusing the server's own credentials, i.e. the same misconfiguration as an
 * unset URL or secret, so it reuses the not-configured sentence. Every other
 * rejection keeps the analysis-rejection sentence.
 */
function definitiveRejectionError(status: number): TRPCError {
  const authRejection = status === 401 || status === 403;
  return new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: authRejection
      ? SECURITY_SERVICE_NOT_CONFIGURED_MESSAGE
      : SECURITY_ANALYSIS_REJECTED_MESSAGE,
  });
}

export async function submitManualAnalysisStart(
  params: ManualAnalysisStartParams
): Promise<{ queued: true; commandId: string }> {
  const internalApiSecret = SECURITY_AUTO_ANALYSIS_WORKER_URL ? await readInternalApiSecret() : '';
  if (!SECURITY_AUTO_ANALYSIS_WORKER_URL || !internalApiSecret) {
    // Mirrored by the mobile security mutation classifier: a stable
    // non-retryable code (PRECONDITION_FAILED), not the generic 500 the
    // classifier treats as retryable transport. The sentence is the shared
    // SECURITY_SERVICE_NOT_CONFIGURED_MESSAGE, which the mobile ledger maps
    // by exact match (stable-error-messages). Same contract as the sync and
    // remediation clients.
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: SECURITY_SERVICE_NOT_CONFIGURED_MESSAGE,
    });
  }

  // Bounded, and `BAD_GATEWAY` on a stalled or non-JSON response (see
  // `postSecurityWorkerJson`): both leave the command's acceptance unknown, so
  // the caller must not record one either.
  const { response, body } = await postSecurityWorkerJson({
    url: `${SECURITY_AUTO_ANALYSIS_WORKER_URL}/internal/manual-analysis-start`,
    service: 'analysis',
    internalApiSecret,
    body: {
      schemaVersion: 1,
      findingId: params.findingId,
      owner: params.owner,
      actorUserId: params.actorUserId,
      requestedModels: params.requestedModels,
      forceSandbox: params.forceSandbox,
      retrySandboxOnly: params.retrySandboxOnly,
      restartActive: params.restartActive,
    },
  });
  const workerBody = body as ManualAnalysisResponse | undefined;

  if (!response.ok) {
    const failed = `Security analysis Worker request failed with ${response.status}`;
    // Any other 5xx (including a gateway 503) may have been accepted and stays
    // ambiguous transport; a 4xx, and the known disabled-routing 503 that
    // precedes the command row, are definitive rejections.
    const definitive = isDefinitiveSecurityWorkerRejection({
      status: response.status,
      body: workerBody,
      disabledRoutingError: DISABLED_ROUTING_ERROR,
    });
    if (!definitive) {
      throw new TRPCError({ code: 'BAD_GATEWAY', message: `${failed}. Try again.` });
    }
    // A definitive rejection is terminal, so it is a stable non-retryable code
    // with a shared sentence (never the Worker's body) that the mobile ledger
    // maps by exact match; the body survives only in the server log.
    logDefinitiveRejection('analysis/manual-analysis-start', response.status, workerBody);
    throw definitiveRejectionError(response.status);
  }

  if (
    workerBody?.success !== true ||
    workerBody?.accepted !== true ||
    typeof workerBody?.commandId !== 'string'
  ) {
    // Accepted, but without a readable command id the outcome cannot be
    // recorded, so it is ambiguous rather than a definitive rejection.
    throw new TRPCError({
      code: 'BAD_GATEWAY',
      message: 'Security analysis Worker returned an unexpected response. Try again.',
    });
  }
  return { queued: true, commandId: workerBody.commandId };
}
