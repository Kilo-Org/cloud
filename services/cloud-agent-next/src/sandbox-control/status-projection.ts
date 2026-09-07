import { getSandboxProviderLabel, type SandboxStatusSnapshot } from '../shared/sandbox-status.js';
import type {
  SandboxControlObservation,
  SandboxHeartbeatPayload,
} from '../shared/sandbox-control-protocol.js';
import { sha256Hex } from '../utils/sha256.js';
import { DEADLINE_MS } from './deadlines.js';
import type { StoredSandboxControlState } from './durable-state.js';
import type { SandboxControlConnectionObservation } from './socket.js';

export type ReportedSandboxStatus =
  | 'off'
  | 'booting'
  | 'ready'
  | 'working'
  | 'finalizing'
  | 'degraded'
  | 'shutting-down'
  | 'failed'
  | 'unknown';

export type PhysicalState = 'stopped' | 'creating' | 'running' | 'stopping' | 'failed' | 'unknown';
export type ConnectionState = 'disconnected' | 'connected' | 'ready';
export type WorkState = 'idle' | 'active' | 'finalizing';

export function projectReportedStatus(input: {
  physical: PhysicalState;
  connection: ConnectionState;
  work: WorkState;
}): ReportedSandboxStatus {
  switch (input.physical) {
    case 'stopped':
      return 'off';
    case 'failed':
      return 'failed';
    case 'unknown':
      return 'unknown';
    case 'stopping':
      return 'shutting-down';
    case 'creating':
      return 'booting';
    case 'running':
      if (input.connection === 'disconnected') return 'degraded';
      if (input.connection !== 'ready') return 'booting';
      switch (input.work) {
        case 'idle':
          return 'ready';
        case 'active':
          return 'working';
        case 'finalizing':
          return 'finalizing';
      }
  }
}

export async function summarizeHeartbeatIdle(
  payload: SandboxHeartbeatPayload
): Promise<SandboxControlObservation['idle']> {
  if (
    !payload.kilo.ready ||
    payload.state !== 'idle' ||
    payload.pendingMessages !== 0 ||
    (payload.activeKiloSessions !== undefined && payload.activeKiloSessions !== 0) ||
    payload.sessions.some(session => session.state !== 'idle' || session.waitingOn !== undefined)
  ) {
    return null;
  }
  const sessionIds = payload.sessions.map(session => session.kiloSessionId);
  if (new Set(sessionIds).size !== sessionIds.length) return null;
  return {
    sessionCount: sessionIds.length,
    sessionIdsHash: await sha256Hex(JSON.stringify(sessionIds.sort())),
  };
}

function hasConsistentWorktrees(routes: NonNullable<StoredSandboxControlState['routes']>): boolean {
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

export async function projectSandboxStatus(input: {
  stored: StoredSandboxControlState;
  connection: SandboxControlConnectionObservation;
  ownerId: string | null;
  provider: unknown;
  now: number;
}): Promise<SandboxStatusSnapshot> {
  const { stored, connection, ownerId, now } = input;
  const snapshot: SandboxStatusSnapshot = {
    status: 'unknown',
    provider: getSandboxProviderLabel(input.provider),
    observedAt: now,
    detailCode: 'insufficient_evidence',
    inactivityTimeoutMs: DEADLINE_MS.idleStop,
    estimatedSleepAt: null,
  };
  if (!ownerId || !stored.physical) return snapshot;
  if (stored.runtime) snapshot.runtime = stored.runtime;
  switch (stored.physical.state) {
    case 'stopped':
      return { ...snapshot, status: 'sleeping', detailCode: 'sandbox_stopped' };
    case 'creating':
      return { ...snapshot, status: 'starting', detailCode: 'sandbox_starting' };
    case 'stopping':
      return { ...snapshot, status: 'stopping', detailCode: 'sandbox_stopping' };
    case 'failed':
      return { ...snapshot, status: 'error', detailCode: 'sandbox_failed' };
    case 'unknown':
      return snapshot;
    case 'running':
      break;
  }
  if (stored.physical.stopTombstone) {
    return { ...snapshot, status: 'stopping', detailCode: 'sandbox_stopping' };
  }
  if (connection.state === 'unknown' || stored.physical.providerRef === null) return snapshot;
  if (connection.state === 'disconnected') {
    return { ...snapshot, status: 'unreachable', detailCode: 'connection_unavailable' };
  }
  const { observation } = connection;
  if (observation.receivedAt > now) return snapshot;
  if (now - observation.receivedAt >= DEADLINE_MS.heartbeatExpiry) {
    return { ...snapshot, status: 'unreachable', detailCode: 'connection_unavailable' };
  }
  if (!observation.ready) {
    return { ...snapshot, status: 'starting', detailCode: 'sandbox_starting' };
  }

  const { idle } = observation;
  const { routes } = stored;
  const idleStop = stored.deadlines?.idleStop;
  let estimatedSleepAt: number | null = null;
  if (
    idle &&
    idleStop !== undefined &&
    idleStop > now &&
    idleStop - DEADLINE_MS.idleStop >= connection.acceptedAt &&
    idleStop - DEADLINE_MS.idleStop <= observation.receivedAt &&
    routes &&
    routes.length === idle.sessionCount &&
    new Set(routes.map(route => route.sessionId)).size === routes.length &&
    new Set(routes.map(route => route.kiloSessionId)).size === routes.length &&
    hasConsistentWorktrees(routes) &&
    routes.every(
      route =>
        route.ownerId === ownerId &&
        route.lastState === 'idle' &&
        route.lastStateAt !== null &&
        route.lastStateAt >= observation.receivedAt &&
        route.lastStateAt <= now &&
        route.idleForMs !== null &&
        route.waitingOn === null
    ) &&
    (await sha256Hex(JSON.stringify(routes.map(route => route.kiloSessionId).sort()))) ===
      idle.sessionIdsHash
  ) {
    estimatedSleepAt = idleStop;
  }
  return { ...snapshot, status: 'active', detailCode: 'sandbox_ready', estimatedSleepAt };
}
