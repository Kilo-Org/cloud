import 'server-only';
import { INTERNAL_API_SECRET, SECURITY_SYNC_WORKER_URL } from '@/lib/config.server';

type ManualFindingDismissalOwner =
  | { organizationId: string; userId?: never }
  | { userId: string; organizationId?: never };

type ManualFindingDismissalActor = {
  id: string;
  email?: string | null;
  name?: string | null;
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
  runId: string;
  messageId: string;
};

type ManualFindingDismissalWorkerResponse = {
  success?: boolean;
  accepted?: boolean;
  runId?: string;
  messageId?: string;
  error?: string;
};

export async function submitManualFindingDismissal(
  params: SubmitManualFindingDismissalParams
): Promise<AcceptedManualFindingDismissal> {
  if (!SECURITY_SYNC_WORKER_URL) {
    throw new Error('SECURITY_SYNC_WORKER_URL is not configured');
  }

  if (!INTERNAL_API_SECRET) {
    throw new Error('INTERNAL_API_SECRET is not configured');
  }

  const response = await fetch(`${SECURITY_SYNC_WORKER_URL}/internal/dismiss-finding`, {
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
  const body = (await response.json()) as ManualFindingDismissalWorkerResponse;

  if (!response.ok) {
    throw new Error(
      body.error ?? `Security dismissal Worker request failed with ${response.status}`
    );
  }

  if (
    body.success !== true ||
    body.accepted !== true ||
    typeof body.runId !== 'string' ||
    typeof body.messageId !== 'string'
  ) {
    throw new Error('Security dismissal Worker returned an invalid accepted response');
  }

  return {
    accepted: true,
    runId: body.runId,
    messageId: body.messageId,
  };
}
