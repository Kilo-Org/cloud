import 'server-only';
import { INTERNAL_API_SECRET, SECURITY_AUTO_ANALYSIS_WORKER_URL } from '@/lib/config.server';
import {
  SECURITY_REMEDIATION_ADMISSION_REJECTION_REASONS,
  type SecurityRemediationAdmissionRejectionReason,
} from '@kilocode/worker-utils/security-remediation-policy';
import { z } from 'zod';

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

const ManualRemediationStartResponseSchema = z.discriminatedUnion('admitted', [
  z.object({
    success: z.literal(true),
    accepted: z.literal(true),
    admitted: z.literal(true),
    remediationId: z.string(),
    attemptId: z.string(),
    attemptNumber: z.number(),
  }),
  z.object({
    success: z.literal(false),
    accepted: z.literal(false),
    admitted: z.literal(false),
    reason: z.enum(SECURITY_REMEDIATION_ADMISSION_REJECTION_REASONS),
  }),
]);

const WorkerErrorResponseSchema = z.object({ error: z.string() });

export type ManualRemediationStartResult =
  | {
      queued: true;
      remediationId: string;
      attemptId: string;
      attemptNumber: number;
    }
  | {
      queued: false;
      reason: SecurityRemediationAdmissionRejectionReason;
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

export async function submitManualRemediationStart(
  params: ManualRemediationStartParams
): Promise<ManualRemediationStartResult> {
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
  const body: unknown = await response.json();
  const parsedBody = ManualRemediationStartResponseSchema.safeParse(body);
  if (!response.ok) {
    if (parsedBody.success && !parsedBody.data.admitted) {
      const expectedStatus = parsedBody.data.reason === 'finding_not_found' ? 404 : 409;
      if (response.status === expectedStatus) {
        return { queued: false, reason: parsedBody.data.reason };
      }
    }
    const parsedError = WorkerErrorResponseSchema.safeParse(body);
    throw new Error(
      parsedError.success
        ? parsedError.data.error
        : `Remediation request failed with ${response.status}`
    );
  }
  if (!parsedBody.success || !parsedBody.data.admitted) {
    throw new Error('Security remediation Worker returned an invalid accepted response');
  }
  return {
    queued: true,
    remediationId: parsedBody.data.remediationId,
    attemptId: parsedBody.data.attemptId,
    attemptNumber: parsedBody.data.attemptNumber,
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
