import 'server-only';
import {
  postSecurityWorkerCommand,
  type AcceptedSecurityWorkerCommand,
} from './security-sync-worker-client';
import type { SecurityReviewOwner } from '../core/types';
import type { DismissReason } from '../core/schemas';

type SubmitManualFindingDismissalParams = {
  owner: SecurityReviewOwner;
  actor: { id: string; email?: string | null };
  findingId: string;
  installationId: string;
  reason: DismissReason;
  comment?: string;
  /** Stable per-intent operation key; the Worker reuses the original command on a same-key retry. */
  operationKey?: string;
};

export async function submitManualFindingDismissal(
  params: SubmitManualFindingDismissalParams
): Promise<AcceptedSecurityWorkerCommand> {
  return postSecurityWorkerCommand({
    path: '/internal/dismiss-finding',
    service: 'dismissal',
    disabledRoutingError: 'Finding dismissal Worker routing is disabled',
    body: {
      schemaVersion: 1,
      owner: params.owner,
      actor: params.actor,
      findingId: params.findingId,
      installationId: params.installationId,
      reason: params.reason,
      comment: params.comment,
      ...(params.operationKey !== undefined ? { operationKey: params.operationKey } : {}),
    },
  });
}
