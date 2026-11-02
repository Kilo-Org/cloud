/**
 * Worker admin action allowlist (client-safe: no crypto dependencies).
 *
 * Shared by the Workers, the web issuer, and the browser client so all three
 * agree on which actions a capability may name.
 */

export const GASTOWN_ADMIN_AUDIENCE = 'gastown-admin';
export const WASTELAND_ADMIN_AUDIENCE = 'wasteland-admin';

export const WORKER_ADMIN_AUDIENCES = [GASTOWN_ADMIN_AUDIENCE, WASTELAND_ADMIN_AUDIENCE] as const;

export type WorkerAdminAudience = (typeof WORKER_ADMIN_AUDIENCES)[number];

export const WORKER_ADMIN_TARGET_KINDS = ['town', 'user', 'wasteland', 'service'] as const;
export type WorkerAdminTargetKind = (typeof WORKER_ADMIN_TARGET_KINDS)[number];

export type WorkerAdminActionAccess = 'read' | 'write';

export type WorkerAdminAction = {
  targetKind: WorkerAdminTargetKind;
  access: WorkerAdminActionAccess;
};

function action(
  targetKind: WorkerAdminTargetKind,
  access: WorkerAdminActionAccess
): WorkerAdminAction {
  return { targetKind, access };
}

const gastownActions: Record<string, WorkerAdminAction> = {
  'trpc:gastown.getTown': action('town', 'read'),
  'trpc:gastown.getDrainStatus': action('town', 'read'),
  'trpc:gastown.checkAdminAccess': action('town', 'read'),
  'trpc:gastown.listRigs': action('town', 'read'),
  'trpc:gastown.getRig': action('town', 'read'),
  'trpc:gastown.listBeads': action('town', 'read'),
  'trpc:gastown.listAgents': action('town', 'read'),
  'trpc:gastown.getMayorStatus': action('town', 'read'),
  'trpc:gastown.getAlarmStatus': action('town', 'read'),
  'trpc:gastown.getBillingStatus': action('town', 'read'),
  'trpc:gastown.getTownConfig': action('town', 'read'),
  'trpc:gastown.getBeadEvents': action('town', 'read'),
  'trpc:gastown.getTownEvents': action('town', 'read'),
  'trpc:gastown.getMergeQueueData': action('town', 'read'),
  'trpc:gastown.listConvoys': action('town', 'read'),
  'trpc:gastown.getConvoy': action('town', 'read'),
  'trpc:gastown.getTownWastelandConnection': action('town', 'read'),
  'trpc:gastown.adminListBeads': action('town', 'read'),
  'trpc:gastown.adminListAgents': action('town', 'read'),
  'trpc:gastown.adminGetAlarmStatus': action('town', 'read'),
  'trpc:gastown.adminGetTownEvents': action('town', 'read'),
  'trpc:gastown.adminGetBead': action('town', 'read'),
  'trpc:gastown.debugAgentMetadata': action('town', 'read'),
  'trpc:gastown.adminForceResetAgent': action('town', 'write'),
  'trpc:gastown.adminForceCloseBead': action('town', 'write'),
  'trpc:gastown.adminForceFailBead': action('town', 'write'),
  'trpc:gastown.adminForceRestartContainer': action('town', 'write'),
  'trpc:gastown.adminBulkDeleteBeads': action('town', 'write'),
  'trpc:gastown.adminDeleteBeadsByStatus': action('town', 'write'),
  'rest:GET /api/towns/:townId/config': action('town', 'read'),
  'rest:GET /api/towns/:townId/cloudflare-debug': action('town', 'read'),
  'rest:GET /api/towns/:townId/escalations': action('town', 'read'),
  'rest:PATCH /api/towns/:townId/config': action('town', 'write'),
  'rest:GET /api/users/:userId/towns': action('user', 'read'),
  'rest:GET /api/users/:userId/towns/:townId': action('user', 'read'),
  'rest:GET /api/users/:userId/towns/:townId/rigs': action('user', 'read'),
  'rest:GET /api/users/:userId/towns/:townId/events': action('user', 'read'),
  'rest:GET /api/users/:userId/rigs/:rigId': action('user', 'read'),
};

const wastelandActions: Record<string, WorkerAdminAction> = {
  'trpc:wasteland.getWasteland': action('wasteland', 'read'),
  'trpc:wasteland.listMembers': action('wasteland', 'read'),
  'trpc:wasteland.listConnectedTowns': action('wasteland', 'read'),
  'trpc:wasteland.browseWantedBoard': action('wasteland', 'read'),
  'trpc:wasteland.getWantedBoardCounts': action('wasteland', 'read'),
  'trpc:wasteland.getRig': action('wasteland', 'read'),
  'trpc:wasteland.getWantedItem': action('wasteland', 'read'),
  'trpc:wasteland.listRigActivity': action('wasteland', 'read'),
  'trpc:wasteland.listUpstreamRigs': action('wasteland', 'read'),
  'trpc:wasteland.listInboxItems': action('wasteland', 'read'),
  'trpc:wasteland.adminListWastelands': action('service', 'read'),
};

export const WORKER_ADMIN_ACTIONS: Record<
  WorkerAdminAudience,
  Readonly<Record<string, WorkerAdminAction>>
> = {
  [GASTOWN_ADMIN_AUDIENCE]: gastownActions,
  [WASTELAND_ADMIN_AUDIENCE]: wastelandActions,
};

export function workerAdminServiceTarget(audience: WorkerAdminAudience): {
  kind: 'service';
  id: string;
} {
  return {
    kind: 'service',
    id: audience === GASTOWN_ADMIN_AUDIENCE ? 'gastown' : 'wasteland',
  };
}

export function findWorkerAdminAction(
  audience: WorkerAdminAudience,
  actionId: string
): WorkerAdminAction | undefined {
  return WORKER_ADMIN_ACTIONS[audience][actionId];
}

export function capabilityTargetKind(
  audience: WorkerAdminAudience,
  actionId: string
): WorkerAdminTargetKind | undefined {
  return findWorkerAdminAction(audience, actionId)?.targetKind;
}

export function capabilityActionAccess(
  audience: WorkerAdminAudience,
  actionId: string
): WorkerAdminActionAccess | undefined {
  return findWorkerAdminAction(audience, actionId)?.access;
}
