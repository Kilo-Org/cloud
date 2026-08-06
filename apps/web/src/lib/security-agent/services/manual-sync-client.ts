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

// The Worker's known disabled-routing response: returned with status 503
// BEFORE enqueueing when command routing is paused. It is a definitive
// pre-acceptance rejection — the Worker will never accept while routing is
// paused — not ambiguous transport.
const MANUAL_SYNC_DISABLED_ROUTING_ERROR = 'Manual sync Worker routing is disabled';

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
      // Non-JSON response body (e.g. gateway HTML/error page). The Worker may
      // still have accepted and enqueued the command, so this is ambiguous
      // transport — never a definitive rejection.
      throw new TRPCError({
        code: 'BAD_GATEWAY',
        message: 'Could not reach the security sync service. Try again.',
      });
    }
  } catch (error) {
    if (error instanceof TRPCError) {
      throw error;
    }
    // A network failure is ambiguous transport: the command may have been
    // accepted before the connection dropped.
    throw new TRPCError({
      code: 'BAD_GATEWAY',
      message: 'Could not reach the security sync service. Try again.',
    });
  }

  if (!response.ok) {
    // The known disabled-routing 503 is a definitive pre-acceptance rejection:
    // the Worker returns it before enqueueing, so the row settles `failed` and
    // a later retry must be a fresh intent. Match the exact known body only —
    // a gateway 503 with arbitrary HTML stays ambiguous transport below.
    if (
      response.status === 503 &&
      body?.success === false &&
      body?.error === MANUAL_SYNC_DISABLED_ROUTING_ERROR
    ) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: `Security sync service request failed (status ${response.status}).`,
      });
    }
    // A 5xx is ambiguous transport: the Worker may or may not have accepted.
    if (response.status >= 500) {
      throw new TRPCError({
        code: 'BAD_GATEWAY',
        message: `Security sync service request failed (status ${response.status}). Try again.`,
      });
    }
    // A 4xx is a definitive pre-acceptance rejection (validation, auth).
    // Do not blindly interpolate body.error — the worker may not be ours and
    // the body can be attacker/gateway-controlled HTML. Keep the message short
    // and non-secret.
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `Security sync service request failed (status ${response.status}).`,
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
    // A 2xx with an invalid accepted shape: the Worker accepted the command
    // but the correlation ids were lost, so the provider reference cannot be
    // recorded. Ambiguous transport.
    throw new TRPCError({
      code: 'BAD_GATEWAY',
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
