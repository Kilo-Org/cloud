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

// The Worker's known disabled-routing response: returned with status 503
// BEFORE enqueueing when command routing is paused. It is a definitive
// pre-acceptance rejection — the Worker will never accept while routing is
// paused — not ambiguous transport.
const FINDING_DISMISSAL_DISABLED_ROUTING_ERROR = 'Finding dismissal Worker routing is disabled';

// Missing Worker configuration (URL or internal secret) is a definitive
// server-side precondition failure: the request can never be accepted until
// the deployment is reconfigured, so a retry fails identically. It surfaces
// as a stable non-retryable code (PRECONDITION_FAILED), not the generic 500
// the mobile classifier would treat as retryable transport. The message is a
// cross-package contract mirrored by the mobile security mutation classifier.
const FINDING_DISMISSAL_CONFIG_ERROR_MESSAGE = 'Security service is not configured';

export async function submitManualFindingDismissal(
  params: SubmitManualFindingDismissalParams
): Promise<AcceptedManualFindingDismissal> {
  if (!SECURITY_SYNC_WORKER_URL || !INTERNAL_API_SECRET) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: FINDING_DISMISSAL_CONFIG_ERROR_MESSAGE,
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
    // The known disabled-routing 503 is a definitive pre-acceptance rejection:
    // the Worker returns it before enqueueing, so the row settles `failed` and
    // a later retry must be a fresh intent. Match the exact known body only —
    // a gateway 503 with arbitrary HTML stays ambiguous transport below.
    if (
      response.status === 503 &&
      body?.success === false &&
      body?.error === FINDING_DISMISSAL_DISABLED_ROUTING_ERROR
    ) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: `Security dismissal service request failed (status ${response.status}).`,
      });
    }
    // A 5xx is ambiguous transport: the Worker may or may not have accepted.
    if (response.status >= 500) {
      throw new TRPCError({
        code: 'BAD_GATEWAY',
        message: `Security dismissal service request failed (status ${response.status}). Try again.`,
      });
    }
    // A 4xx is a definitive pre-acceptance rejection (validation, auth).
    // Do not blindly interpolate body.error — the worker may not be ours and
    // the body can be attacker/gateway-controlled HTML. Keep the message short
    // and non-secret.
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
