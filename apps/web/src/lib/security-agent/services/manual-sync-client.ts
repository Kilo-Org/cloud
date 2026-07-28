import 'server-only';
import { TRPCError } from '@trpc/server';
import { INTERNAL_API_SECRET, SECURITY_SYNC_WORKER_URL } from '@/lib/config.server';

type ManualSecuritySyncOwner =
  | { organizationId: string; userId?: never }
  | { userId: string; organizationId?: never };

type ManualSecuritySyncActor = {
  id: string;
  email?: string | null;
  name?: string | null;
};

type SubmitManualSecuritySyncParams = {
  owner: ManualSecuritySyncOwner;
  actor: ManualSecuritySyncActor;
  repoFullName?: string;
  origin?: 'manual' | 'dashboard_refresh' | 'enable_initial_sync';
};

type AcceptedManualSecuritySync = {
  accepted: true;
  commandId: string;
  runId: string;
  messageId: string;
};

type ManualSecuritySyncWorkerResponse = {
  success?: boolean;
  accepted?: boolean;
  commandId?: string;
  runId?: string;
  messageId?: string;
  error?: string;
};

export async function submitManualSecuritySync(
  params: SubmitManualSecuritySyncParams
): Promise<AcceptedManualSecuritySync> {
  if (!SECURITY_SYNC_WORKER_URL) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Security sync service is not configured',
    });
  }

  if (!INTERNAL_API_SECRET) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Security sync service is not configured',
    });
  }

  let response: Response;
  let body: ManualSecuritySyncWorkerResponse | undefined;
  try {
    response = await fetch(`${SECURITY_SYNC_WORKER_URL}/internal/manual-sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-api-key': INTERNAL_API_SECRET,
      },
      body: JSON.stringify({
        schemaVersion: 1,
        owner: params.owner,
        actor: params.actor,
        origin: params.origin,
        repoFullName: params.repoFullName,
      }),
    });
    try {
      body = (await response.json()) as ManualSecuritySyncWorkerResponse;
    } catch {
      // Non-JSON response body (e.g. gateway HTML/error page) — treat as transport failure
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Could not reach the security sync service. Try again.',
      });
    }
  } catch (error) {
    if (error instanceof TRPCError) {
      throw error;
    }
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Could not reach the security sync service. Try again.',
    });
  }

  if (!response.ok) {
    // Do not blindly interpolate body.error — the worker may not be ours and the body
    // can be attacker/gateway-controlled HTML. Keep the message short and non-secret.
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `Security sync service request failed (status ${response.status}). Try again.`,
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
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Security sync service returned an unexpected response. Try again.',
    });
  }

  return {
    accepted: true,
    commandId: body.commandId,
    runId: body.runId,
    messageId: body.messageId,
  };
}
