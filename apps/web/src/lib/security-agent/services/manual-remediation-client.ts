import 'server-only';
import { INTERNAL_API_SECRET, SECURITY_AUTO_ANALYSIS_WORKER_URL } from '@/lib/config.server';

type RemediationOwner =
  | { organizationId: string; userId?: never }
  | { userId: string; organizationId?: never };

type ManualRemediationStartParams = {
  findingId: string;
  owner: RemediationOwner;
  actorUserId: string;
  retry?: boolean;
};

type RemediationCancellationParams = {
  attemptId: string;
  owner: RemediationOwner;
  actorUserId: string;
};

type ApplyAutoRemediationParams = {
  commandId: string;
  owner: RemediationOwner;
  actorUserId: string;
};

type ManualRemediationStartResponse = {
  success?: boolean;
  accepted?: boolean;
  admitted?: boolean;
  remediationId?: string;
  attemptId?: string;
  attemptNumber?: number;
  reason?: string;
  error?: string;
};

type RemediationCancellationResponse = {
  success?: boolean;
  status?: 'cancelled' | 'cancellation_requested';
  error?: string;
};

type ApplyAutoRemediationResponse = {
  success?: boolean;
  accepted?: boolean;
  commandId?: string;
  error?: string;
};

function requireWorkerConfig() {
  if (!SECURITY_AUTO_ANALYSIS_WORKER_URL) {
    throw new Error('SECURITY_AUTO_ANALYSIS_WORKER_URL is not configured');
  }
  if (!INTERNAL_API_SECRET) {
    throw new Error('INTERNAL_API_SECRET is not configured');
  }
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export async function submitManualRemediationStart(params: ManualRemediationStartParams): Promise<{
  queued: true;
  remediationId: string;
  attemptId: string;
  attemptNumber: number;
}> {
  requireWorkerConfig();

  const response = await fetch(`${SECURITY_AUTO_ANALYSIS_WORKER_URL}/internal/remediation/start`, {
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
      retry: params.retry,
    }),
  });
  const body = await parseJsonResponse<ManualRemediationStartResponse>(response);
  if (!response.ok) {
    throw new Error(
      body.reason ?? body.error ?? `Remediation request failed with ${response.status}`
    );
  }
  if (
    body.success !== true ||
    body.accepted !== true ||
    body.admitted !== true ||
    typeof body.remediationId !== 'string' ||
    typeof body.attemptId !== 'string' ||
    typeof body.attemptNumber !== 'number'
  ) {
    throw new Error('Security remediation Worker returned an invalid accepted response');
  }
  return {
    queued: true,
    remediationId: body.remediationId,
    attemptId: body.attemptId,
    attemptNumber: body.attemptNumber,
  };
}

export async function submitRemediationCancellation(
  params: RemediationCancellationParams
): Promise<{ success: true; status: 'cancelled' | 'cancellation_requested' }> {
  requireWorkerConfig();

  const response = await fetch(`${SECURITY_AUTO_ANALYSIS_WORKER_URL}/internal/remediation/cancel`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-api-key': INTERNAL_API_SECRET,
    },
    body: JSON.stringify({
      schemaVersion: 1,
      attemptId: params.attemptId,
      owner: params.owner,
      actorUserId: params.actorUserId,
    }),
  });
  const body = await parseJsonResponse<RemediationCancellationResponse>(response);
  if (!response.ok) {
    throw new Error(body.error ?? `Remediation cancellation failed with ${response.status}`);
  }
  if (body.success !== true || !body.status) {
    throw new Error('Security remediation Worker returned an invalid cancellation response');
  }
  return { success: true, status: body.status };
}

export async function submitApplyAutoRemediation(
  params: ApplyAutoRemediationParams
): Promise<{ queued: true; commandId: string }> {
  requireWorkerConfig();

  const response = await fetch(
    `${SECURITY_AUTO_ANALYSIS_WORKER_URL}/internal/apply-auto-remediation`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-api-key': INTERNAL_API_SECRET,
      },
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: params.commandId,
        owner: params.owner,
        actorUserId: params.actorUserId,
      }),
    }
  );
  const body = await parseJsonResponse<ApplyAutoRemediationResponse>(response);
  if (!response.ok) {
    throw new Error(body.error ?? `Apply auto-remediation failed with ${response.status}`);
  }
  if (body.success !== true || body.accepted !== true || body.commandId !== params.commandId) {
    throw new Error('Security remediation Worker returned an invalid command response');
  }
  return { queued: true, commandId: body.commandId };
}
