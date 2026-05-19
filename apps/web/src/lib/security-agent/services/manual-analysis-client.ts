import 'server-only';
import { INTERNAL_API_SECRET, SECURITY_AUTO_ANALYSIS_WORKER_URL } from '@/lib/config.server';

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
  retrySandboxOnly?: boolean;
};

type ManualAnalysisResponse = {
  success?: boolean;
  accepted?: boolean;
  error?: string;
};

export async function submitManualAnalysisStart(
  params: ManualAnalysisStartParams
): Promise<{ queued: true }> {
  if (!SECURITY_AUTO_ANALYSIS_WORKER_URL) {
    throw new Error('SECURITY_AUTO_ANALYSIS_WORKER_URL is not configured');
  }
  if (!INTERNAL_API_SECRET) {
    throw new Error('INTERNAL_API_SECRET is not configured');
  }

  const response = await fetch(
    `${SECURITY_AUTO_ANALYSIS_WORKER_URL}/internal/manual-analysis-start`,
    {
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
        retrySandboxOnly: params.retrySandboxOnly,
      }),
    }
  );
  const body = (await response.json()) as ManualAnalysisResponse;
  if (!response.ok) {
    throw new Error(
      body.error ?? `Security analysis Worker request failed with ${response.status}`
    );
  }
  if (body.success !== true || body.accepted !== true) {
    throw new Error('Security analysis Worker returned an invalid accepted response');
  }
  return { queued: true };
}
