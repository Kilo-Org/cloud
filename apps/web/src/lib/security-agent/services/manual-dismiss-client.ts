import 'server-only';
import {
  postSecurityWorkerCommand,
  type AcceptedSecurityWorkerCommand,
} from './security-sync-worker-client';

type ManualFindingDismissalOwner =
  | { organizationId: string; userId?: never }
  | { userId: string; organizationId?: never };

type DismissReason = 'fix_started' | 'no_bandwidth' | 'tolerable_risk' | 'inaccurate' | 'not_used';

type SubmitManualFindingDismissalParams = {
  owner: ManualFindingDismissalOwner;
  actor: { id: string };
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
