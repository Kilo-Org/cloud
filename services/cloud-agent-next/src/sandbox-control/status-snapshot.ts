/**
 * Compatibility projection from the canonical allocation/health aggregate into
 * the public `SandboxStatusSnapshot`. The route schema is unchanged; the public
 * label/detail pair is the canonical `projectStatus` output, including the
 * `check_needed` detail.
 *
 * Runtime metadata, routes and the connection observation are folded in here so
 * `getSandboxStatus` no longer reads the stored flat/deadline state.
 */
import {
  getSandboxProviderLabel,
  type SandboxRuntimeMetadata,
  type SandboxStatusSnapshot,
} from '../shared/sandbox-status.js';
import type { AllocationRecord } from '../sandbox-state/model/allocation.js';
import { projectStatus } from '../sandbox-state/project/status.js';
import { POLICY } from '../sandbox-state/schedule.js';
import { sha256Hex } from '../utils/sha256.js';
import type { SessionRoute } from './session-routes.js';
import type { SandboxControlConnectionObservation } from './socket.js';

export type StatusSnapshotInput = {
  allocation: AllocationRecord | null;
  ownerId: string | null;
  provider: unknown;
  runtime?: SandboxRuntimeMetadata;
  routes?: readonly SessionRoute[] | null;
  connection: SandboxControlConnectionObservation;
  now: number;
};

type PublicPair = Pick<SandboxStatusSnapshot, 'status' | 'detailCode'>;

function hasConsistentWorktrees(routes: readonly SessionRoute[]): boolean {
  const directories = new Map<string, string | undefined>();
  const worktrees = new Map<string, string>();
  for (const route of routes) {
    if (
      directories.has(route.directory) &&
      (!route.worktreeId || directories.get(route.directory) !== route.worktreeId)
    )
      return false;
    if (
      route.worktreeId &&
      worktrees.has(route.worktreeId) &&
      worktrees.get(route.worktreeId) !== route.directory
    )
      return false;
    directories.set(route.directory, route.worktreeId);
    if (route.worktreeId) worktrees.set(route.worktreeId, route.directory);
  }
  return true;
}

/**
 * Mirrors the legacy sleep-estimate validation: authoritative idle evidence from
 * a consistent route table, and the idle anchor unchanged by a heartbeat.
 */
async function estimateSleepAt(input: {
  idleAt: number;
  connection: Extract<SandboxControlConnectionObservation, { state: 'connected' }>;
  routes: readonly SessionRoute[] | null | undefined;
  ownerId: string;
  now: number;
}): Promise<number | null> {
  const { idleAt, connection, routes, ownerId, now } = input;
  const { observation } = connection;
  const idle = observation.idle;
  if (!idle || idleAt <= now) return null;
  const idleArmedAt = idleAt - POLICY.idleStopMs;
  if (idleArmedAt < connection.acceptedAt || idleArmedAt > observation.receivedAt) return null;
  if (!routes) return null;
  if (routes.length !== idle.sessionCount) return null;
  if (new Set(routes.map(route => route.sessionId)).size !== routes.length) return null;
  if (new Set(routes.map(route => route.kiloSessionId)).size !== routes.length) return null;
  if (!hasConsistentWorktrees(routes)) return null;
  if (
    !routes.every(
      route =>
        route.ownerId === ownerId &&
        route.lastState === 'idle' &&
        route.lastStateAt !== null &&
        route.lastStateAt >= observation.receivedAt &&
        route.lastStateAt <= now &&
        route.idleForMs !== null &&
        route.waitingOn === null
    )
  ) {
    return null;
  }
  const hash = await sha256Hex(JSON.stringify(routes.map(route => route.kiloSessionId).sort()));
  return hash === idle.sessionIdsHash ? idleAt : null;
}

export async function projectStatusSnapshot(
  input: StatusSnapshotInput
): Promise<SandboxStatusSnapshot> {
  const { allocation, ownerId, runtime, routes, connection, now } = input;
  const snapshot: SandboxStatusSnapshot = {
    status: 'unknown',
    provider: getSandboxProviderLabel(input.provider),
    observedAt: now,
    detailCode: 'insufficient_evidence',
    inactivityTimeoutMs: POLICY.idleStopMs,
    estimatedSleepAt: null,
  };
  if (!ownerId || allocation === null) return snapshot;
  if (runtime) snapshot.runtime = runtime;
  const evidence = (pair: PublicPair): SandboxStatusSnapshot => ({ ...snapshot, ...pair });

  if (allocation.state.kind !== 'allocated') {
    return evidence(projectStatus({ allocation, ownerPresent: true, now }));
  }

  const { health, target } = allocation.state;
  if (health.kind === 'unhealthy') {
    return evidence(projectStatus({ allocation, ownerPresent: true, now }));
  }
  if (connection.state === 'unknown' || target.providerRef === null) {
    return evidence({ status: 'unknown', detailCode: 'insufficient_evidence' });
  }
  if (connection.state === 'disconnected') {
    return evidence({ status: 'unreachable', detailCode: 'connection_unavailable' });
  }
  const { observation } = connection;
  if (observation.receivedAt > now) {
    return evidence({ status: 'unknown', detailCode: 'insufficient_evidence' });
  }
  if (now - observation.receivedAt >= POLICY.heartbeatExpiryMs) {
    return evidence({ status: 'unreachable', detailCode: 'connection_unavailable' });
  }

  const projected = projectStatus({ allocation, ownerPresent: true, now });
  if (projected.detailCode !== 'sandbox_ready') return evidence(projected);
  if (!observation.ready) {
    return evidence({ status: 'starting', detailCode: 'sandbox_starting' });
  }
  const estimatedSleepAt = await estimateSleepAt({
    idleAt: allocation.state.idleAt ?? 0,
    connection,
    routes,
    ownerId,
    now,
  });
  return {
    ...snapshot,
    status: 'active',
    detailCode: 'sandbox_ready',
    ...(estimatedSleepAt !== null ? { estimatedSleepAt } : {}),
  };
}
