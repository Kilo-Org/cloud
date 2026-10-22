import 'server-only';
import { TRPCError } from '@trpc/server';
import {
  INTERNAL_API_SECRET,
  SECURITY_AUTO_ANALYSIS_WORKER_URL,
} from '@kilocode/web-shared/lib/config.server';
import { postSecurityWorkerJson } from './security-worker-request';

type ManualAnalysisOwner =
  | { organizationId: string; userId?: never }
  | { userId: string; organizationId?: never };

type ManualAnalysisStartParams = {
  findingId: string;
  owner: ManualAnalysisOwner;
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

export async function submitManualAnalysisStart(
  params: ManualAnalysisStartParams
): Promise<{ queued: true; commandId: string }> {
  if (!SECURITY_AUTO_ANALYSIS_WORKER_URL) {
    throw new Error('SECURITY_AUTO_ANALYSIS_WORKER_URL is not configured');
  }
  if (!INTERNAL_API_SECRET) {
    throw new Error('INTERNAL_API_SECRET is not configured');
  }

  // Bounded, and `BAD_GATEWAY` on a stalled or non-JSON response (see
  // `postSecurityWorkerJson`): both leave the command's acceptance unknown, so
  // the caller must not record one either.
  const { response, body } = await postSecurityWorkerJson({
    url: `${SECURITY_AUTO_ANALYSIS_WORKER_URL}/internal/manual-analysis-start`,
    service: 'analysis',
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
    const definitive =
      response.status < 500 ||
      (response.status === 503 && workerBody?.error === DISABLED_ROUTING_ERROR);
    if (!definitive) {
      throw new TRPCError({ code: 'BAD_GATEWAY', message: `${failed}. Try again.` });
    }
    throw new Error(workerBody?.error ?? failed);
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
