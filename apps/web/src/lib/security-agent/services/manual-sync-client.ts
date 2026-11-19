import 'server-only';
import {
  postSecurityWorkerCommand,
  type AcceptedSecurityWorkerCommand,
} from './security-sync-worker-client';
import type { SecurityReviewOwner } from '../core/types';

type ManualSecuritySyncActor = {
  id: string;
  email?: string | null;
  name?: string | null;
};

type SubmitManualSecuritySyncParams = {
  owner: SecurityReviewOwner;
  actor: ManualSecuritySyncActor;
  repoFullName?: string;
  origin?: 'manual' | 'dashboard_refresh' | 'enable_initial_sync';
  /** Stable per-intent operation key; the Worker reuses the original command on a same-key retry. */
  operationKey?: string;
};

export async function submitManualSecuritySync(
  params: SubmitManualSecuritySyncParams
): Promise<AcceptedSecurityWorkerCommand> {
  return postSecurityWorkerCommand({
    path: '/internal/manual-sync',
    service: 'sync',
    disabledRoutingError: 'Manual sync Worker routing is disabled',
    body: {
      schemaVersion: 1,
      owner: params.owner,
      actor: params.actor,
      origin: params.origin,
      repoFullName: params.repoFullName,
      ...(params.operationKey !== undefined ? { operationKey: params.operationKey } : {}),
    },
  });
}
