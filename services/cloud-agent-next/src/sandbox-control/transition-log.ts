import type { ConnectionState } from '../shared/sandbox-status.js';
import type { SessionActivityState } from './session-routes.js';

export const TRANSITION_LOG_MAX_ROWS = 200;
export const TRANSITION_LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type TransitionKind =
  | 'physical'
  | 'connection'
  | 'session_state'
  | 'deadline'
  | 'provider'
  | 'credential'
  | 'route';

/** Infrastructure alarm anchors still recorded on the transition log. */
export type DeadlineId = 'credentialExpiry' | 'socketHandshake' | 'byocSnapshotRecovery';

export type DeadlineAction = 'armed' | 'cancelled' | 'fired';

export type TransitionRow = {
  at: number;
  kind: TransitionKind;
  from?: string;
  to?: string;
  cause?: string;
  deadlineId?: DeadlineId;
  deadlineAction?: DeadlineAction;
  providerRef?: string | null;
  kiloSessionId?: string;
  sessionId?: string;
  operation?: string;
  resultClass?: string;
};

export function emptyTransitionLog(): TransitionRow[] {
  return [];
}

export function appendTransition(log: TransitionRow[], row: TransitionRow): TransitionRow[] {
  const next = [...log, row];
  return trimTransitionLog(next, row.at);
}

export function trimTransitionLog(log: TransitionRow[], now: number): TransitionRow[] {
  const minAt = now - TRANSITION_LOG_MAX_AGE_MS;
  const aged = log.filter(row => row.at >= minAt);
  if (aged.length <= TRANSITION_LOG_MAX_ROWS) return aged;
  return aged.slice(aged.length - TRANSITION_LOG_MAX_ROWS);
}

export function connectionTransition(
  at: number,
  from: ConnectionState,
  to: ConnectionState,
  cause: string
): TransitionRow {
  return { at, kind: 'connection', from, to, cause };
}

export function sessionStateTransition(
  at: number,
  kiloSessionId: string,
  from: SessionActivityState | null,
  to: SessionActivityState
): TransitionRow {
  return {
    at,
    kind: 'session_state',
    kiloSessionId,
    from: from ?? undefined,
    to,
  };
}

export function deadlineTransition(
  at: number,
  deadlineId: DeadlineId,
  action: DeadlineAction,
  cause?: string
): TransitionRow {
  return { at, kind: 'deadline', deadlineId, deadlineAction: action, cause };
}

export function routeTransition(
  at: number,
  action: 'attach' | 'detach',
  sessionId: string,
  kiloSessionId?: string
): TransitionRow {
  return { at, kind: 'route', cause: action, sessionId, kiloSessionId };
}

export function credentialTransition(at: number, cause: string): TransitionRow {
  return { at, kind: 'credential', cause };
}
