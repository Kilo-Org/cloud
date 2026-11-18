import 'server-only';
import { TRPCError } from '@trpc/server';
import {
  INTERNAL_API_SECRET,
  SECURITY_AUTO_ANALYSIS_WORKER_URL,
} from '@kilocode/web-shared/lib/config.server';
import {
  SECURITY_REMEDIATION_ADMISSION_REJECTION_REASONS,
  type SecurityRemediationAdmissionRejectionReason,
} from '@kilocode/worker-utils/security-remediation-policy';
import { z } from 'zod';
import {
  SECURITY_REMEDIATION_REJECTED_MESSAGE,
  SECURITY_SERVICE_NOT_CONFIGURED_MESSAGE,
} from '@kilocode/app-shared/security-agent';
import { postSecurityWorkerJson } from './security-worker-request';

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

/**
 * Logs a definitive non-5xx Worker rejection before it becomes the stable
 * client error: the status is what separates an internal-secret mismatch (401)
 * or a request-schema drift (400) from a policy rejection (409) once the body
 * is no longer echoed. The Worker's `error` body is notes-only and length-capped.
 *
 * Rejection classes at the throw sites: an auth/config rejection (401/403)
 * means the deployment is misconfigured, so the client gets the
 * service-not-configured sentence (`SECURITY_SERVICE_NOT_CONFIGURED_MESSAGE`).
 * Any other rejection keeps the remediation-rejection sentence. Both go out as
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
  console.error('Security remediation Worker rejected the request', {
    route,
    status,
    ...(notes !== null ? { notes } : {}),
  });
}

/**
 * The stable error for a definitive non-5xx Worker rejection: a 401/403 is the
 * Worker refusing the server's own credentials, i.e. the same misconfiguration
 * as an unset URL or secret, so it reuses the not-configured sentence. Every
 * other rejection keeps the remediation-rejection sentence.
 */
function definitiveRejectionError(status: number): TRPCError {
  const authRejection = status === 401 || status === 403;
  return new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: authRejection
      ? SECURITY_SERVICE_NOT_CONFIGURED_MESSAGE
      : SECURITY_REMEDIATION_REJECTED_MESSAGE,
  });
}

function requireWorkerConfig() {
  if (!SECURITY_AUTO_ANALYSIS_WORKER_URL || !INTERNAL_API_SECRET) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: SECURITY_SERVICE_NOT_CONFIGURED_MESSAGE,
    });
  }
}

/**
 * Ambiguous transport: a 5xx (including a gateway 503) can arrive after the
 * Worker admitted the work, and a stalled or non-JSON response resolves through
 * `postSecurityWorkerJson` to the same class. Both are retryable, and neither
 * may be recorded as a definitive rejection.
 */
function ambiguousTransportError(message: string): TRPCError {
  return new TRPCError({ code: 'BAD_GATEWAY', message: `${message}. Try again.` });
}

export async function submitManualRemediationStart(
  params: ManualRemediationStartParams
): Promise<ManualRemediationStartResult> {
  requireWorkerConfig();

  const { response, body } = await postSecurityWorkerJson({
    url: `${SECURITY_AUTO_ANALYSIS_WORKER_URL}/internal/remediation/start`,
    service: 'remediation',
    body: {
      schemaVersion: 1,
      findingId: params.findingId,
      owner: params.owner,
      actorUserId: params.actorUserId,
      retry: params.retry,
    },
  });
  const parsedBody = ManualRemediationStartResponseSchema.safeParse(body);
  if (!response.ok) {
    if (parsedBody.success && !parsedBody.data.admitted) {
      const expectedStatus = parsedBody.data.reason === 'finding_not_found' ? 404 : 409;
      if (response.status === expectedStatus) {
        return { queued: false, reason: parsedBody.data.reason };
      }
    }
    if (response.status >= 500) {
      throw ambiguousTransportError(`Remediation request failed with ${response.status}`);
    }
    logDefinitiveRejection('remediation/start', response.status, body);
    throw definitiveRejectionError(response.status);
  }
  if (!parsedBody.success || !parsedBody.data.admitted) {
    // Admitted, but without a readable attempt the outcome cannot be recorded,
    // so it is ambiguous rather than a definitive rejection.
    throw ambiguousTransportError('Security remediation Worker returned an unexpected response');
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

  const { response, body } = await postSecurityWorkerJson({
    url: `${SECURITY_AUTO_ANALYSIS_WORKER_URL}/internal/remediation/cancel`,
    service: 'remediation',
    body: {
      schemaVersion: 1,
      attemptId: params.attemptId,
      owner: params.owner,
      actorUserId: params.actorUserId,
    },
  });
  const workerBody = body as RemediationCancellationResponse | undefined;
  if (!response.ok) {
    if (response.status >= 500) {
      throw ambiguousTransportError(`Remediation cancellation failed with ${response.status}`);
    }
    logDefinitiveRejection('remediation/cancel', response.status, body);
    throw definitiveRejectionError(response.status);
  }
  if (workerBody?.success !== true || !workerBody.status) {
    throw ambiguousTransportError('Security remediation Worker returned an unexpected response');
  }
  return { success: true, status: workerBody.status };
}

export async function submitApplyAutoRemediation(
  params: ApplyAutoRemediationParams
): Promise<{ queued: true; commandId: string }> {
  requireWorkerConfig();

  const { response, body } = await postSecurityWorkerJson({
    url: `${SECURITY_AUTO_ANALYSIS_WORKER_URL}/internal/apply-auto-remediation`,
    service: 'remediation',
    body: {
      schemaVersion: 1,
      commandId: params.commandId,
      owner: params.owner,
      actorUserId: params.actorUserId,
    },
  });
  const workerBody = body as ApplyAutoRemediationResponse | undefined;
  if (!response.ok) {
    if (response.status >= 500) {
      throw ambiguousTransportError(`Apply auto-remediation failed with ${response.status}`);
    }
    logDefinitiveRejection('apply-auto-remediation', response.status, body);
    throw definitiveRejectionError(response.status);
  }
  if (
    workerBody?.success !== true ||
    workerBody?.accepted !== true ||
    workerBody.commandId !== params.commandId
  ) {
    throw ambiguousTransportError('Security remediation Worker returned an unexpected response');
  }
  return { queued: true, commandId: workerBody.commandId };
}
