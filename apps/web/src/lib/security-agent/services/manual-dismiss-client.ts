import 'server-only';
import { TRPCError } from '@trpc/server';
import { INTERNAL_API_SECRET, SECURITY_SYNC_WORKER_URL } from '@/lib/config.server';

type ManualFindingDismissalOwner =
  | { organizationId: string; userId?: never }
  | { userId: string; organizationId?: never };

type ManualFindingDismissalActor = {
  id: string;
};

type DismissReason = 'fix_started' | 'no_bandwidth' | 'tolerable_risk' | 'inaccurate' | 'not_used';

type SubmitManualFindingDismissalParams = {
  owner: ManualFindingDismissalOwner;
  actor: ManualFindingDismissalActor;
  findingId: string;
  installationId: string;
  reason: DismissReason;
  comment?: string;
};

type AcceptedManualFindingDismissal = {
  accepted: true;
  commandId: string;
  runId: string;
  messageId: string;
};

type ManualFindingDismissalWorkerResponse = {
  success?: boolean;
  accepted?: boolean;
  commandId?: string;
  runId?: string;
  messageId?: string;
  error?: string;
};

export async function submitManualFindingDismissal(
  params: SubmitManualFindingDismissalParams
): Promise<AcceptedManualFindingDismissal> {
  if (!SECURITY_SYNC_WORKER_URL) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Security dismissal service is not configured',
    });
  }

  if (!INTERNAL_API_SECRET) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Security dismissal service is not configured',
    });
  }

  let response: Response;
  let body: ManualFindingDismissalWorkerResponse | undefined;
  try {
    response = await fetch(`${SECURITY_SYNC_WORKER_URL}/internal/dismiss-finding`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-api-key': INTERNAL_API_SECRET,
      },
      body: JSON.stringify({
        schemaVersion: 1,
        owner: params.owner,
        actor: params.actor,
        findingId: params.findingId,
        installationId: params.installationId,
        reason: params.reason,
        comment: params.comment,
      }),
    });
    try {
      body = (await response.json()) as ManualFindingDismissalWorkerResponse;
    } catch {
      // Non-JSON response body (e.g. gateway HTML/error page). The Worker may
      // still have accepted and enqueued the command, so this is ambiguous
      // transport — never a definitive rejection.
      throw new TRPCError({
        code: 'BAD_GATEWAY',
        message: 'Could not reach the security dismissal service. Try again.',
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
      message: 'Could not reach the security dismissal service. Try again.',
    });
  }

  if (!response.ok) {
    // A 5xx is ambiguous transport: the Worker may or may not have accepted.
    if (response.status >= 500) {
      throw new TRPCError({
        code: 'BAD_GATEWAY',
        message: `Security dismissal service request failed (status ${response.status}). Try again.`,
      });
    }
    // A 4xx is a definitive pre-acceptance rejection. Do not blindly
    // interpolate body.error — the worker may not be ours and the body can be
    // attacker/gateway-controlled HTML. Keep the message short and non-secret.
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `Security dismissal service request failed (status ${response.status}).`,
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
      message: 'Security dismissal service returned an unexpected response. Try again.',
    });
  }

  return {
    accepted: true,
    commandId: body.commandId,
    runId: body.runId,
    messageId: body.messageId,
  };
}
