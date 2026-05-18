import 'server-only';
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
};

type AcceptedManualSecuritySync = {
  accepted: true;
  runId: string;
  messageId: string;
};

type ManualSecuritySyncWorkerResponse = {
  success?: boolean;
  accepted?: boolean;
  runId?: string;
  messageId?: string;
  error?: string;
};

export async function submitManualSecuritySync(
  params: SubmitManualSecuritySyncParams
): Promise<AcceptedManualSecuritySync> {
  if (!SECURITY_SYNC_WORKER_URL) {
    throw new Error('SECURITY_SYNC_WORKER_URL is not configured');
  }

  if (!INTERNAL_API_SECRET) {
    throw new Error('INTERNAL_API_SECRET is not configured');
  }

  const response = await fetch(`${SECURITY_SYNC_WORKER_URL}/internal/manual-sync`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-api-key': INTERNAL_API_SECRET,
    },
    body: JSON.stringify({
      schemaVersion: 1,
      owner: params.owner,
      actor: params.actor,
      repoFullName: params.repoFullName,
    }),
  });
  const body = (await response.json()) as ManualSecuritySyncWorkerResponse;

  if (!response.ok) {
    throw new Error(body.error ?? `Security sync Worker request failed with ${response.status}`);
  }

  if (
    body.success !== true ||
    body.accepted !== true ||
    typeof body.runId !== 'string' ||
    typeof body.messageId !== 'string'
  ) {
    throw new Error('Security sync Worker returned an invalid accepted response');
  }

  return {
    accepted: true,
    runId: body.runId,
    messageId: body.messageId,
  };
}
