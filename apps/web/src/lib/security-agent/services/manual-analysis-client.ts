import 'server-only';
import {
  INTERNAL_API_SECRET,
  SECURITY_AUTO_ANALYSIS_WORKER_URL,
} from '@kilocode/web-shared/lib/config.server';

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

/** A transport-level failure: the Worker may still have received the request. */
export class WorkerTransportError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'WorkerTransportError';
    this.status = status;
  }
}

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

  let response: Response;
  try {
    response = await fetch(`${SECURITY_AUTO_ANALYSIS_WORKER_URL}/internal/manual-analysis-start`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-api-key': INTERNAL_API_SECRET,
      },
      body: JSON.stringify({
        schemaVersion: 1,
        findingId: params.findingId,
        owner: params.owner,
        actorUserId: params.actorUserId,
        requestedModels: params.requestedModels,
        forceSandbox: params.forceSandbox,
        retrySandboxOnly: params.retrySandboxOnly,
        restartActive: params.restartActive,
      }),
    });
  } catch (error) {
    throw new WorkerTransportError(
      `Security analysis Worker request failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  let body: ManualAnalysisResponse;
  try {
    body = (await response.json()) as ManualAnalysisResponse;
  } catch {
    throw new WorkerTransportError(
      'Security analysis Worker returned a non-JSON response',
      response.status
    );
  }
  if (!response.ok) {
    // The known disabled-routing 503 is returned before enqueueing, so it is
    // a definitive rejection. Any other 5xx may have been accepted and stays
    // ambiguous transport.
    const definitive =
      response.status < 500 || (response.status === 503 && body.error === DISABLED_ROUTING_ERROR);
    if (!definitive) {
      throw new WorkerTransportError(
        body.error ?? `Security analysis Worker request failed with ${response.status}`,
        response.status
      );
    }
    throw new Error(
      body.error ?? `Security analysis Worker request failed with ${response.status}`
    );
  }
  if (body.success !== true || body.accepted !== true || typeof body.commandId !== 'string') {
    throw new WorkerTransportError(
      'Security analysis Worker returned an invalid accepted response'
    );
  }
  return { queued: true, commandId: body.commandId };
}
