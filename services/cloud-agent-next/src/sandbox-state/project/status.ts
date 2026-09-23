/**
 * Pure public status projection (design §5). One label plus one detail code from
 * the canonical state, evidence and `now`. No I/O and no clock read.
 *
 * The label/detail unions mirror `shared/sandbox-status.ts`, including the
 * `check_needed` detail.
 */
import type { AllocationRecord } from '../model/allocation.js';

export type PublicStatusLabel =
  | 'active'
  | 'sleeping'
  | 'starting'
  | 'stopping'
  | 'error'
  | 'unreachable'
  | 'unknown';

export type PublicStatusDetail =
  | 'sandbox_ready'
  | 'sandbox_stopped'
  | 'sandbox_starting'
  | 'sandbox_stopping'
  | 'sandbox_failed'
  | 'connection_unavailable'
  | 'status_unavailable'
  | 'insufficient_evidence'
  | 'check_needed';

export type StatusProjection = {
  status: PublicStatusLabel;
  detailCode: PublicStatusDetail;
};

export type StatusProjectionInput = {
  allocation: AllocationRecord | null;
  ownerPresent: boolean;
  now: number;
};

const UNKNOWN: StatusProjection = { status: 'unknown', detailCode: 'insufficient_evidence' };

export function projectStatus(input: StatusProjectionInput): StatusProjection {
  const { allocation, ownerPresent, now } = input;
  if (!ownerPresent || allocation === null) return UNKNOWN;

  const { state } = allocation;
  switch (state.kind) {
    case 'stopped':
      return { status: 'sleeping', detailCode: 'sandbox_stopped' };
    case 'creating':
      return { status: 'starting', detailCode: 'sandbox_starting' };
    case 'stopping':
      return { status: 'stopping', detailCode: 'sandbox_stopping' };
    case 'unknown':
      return UNKNOWN;
    case 'allocated':
      break;
  }

  switch (state.health.kind) {
    case 'connecting':
      return { status: 'starting', detailCode: 'sandbox_starting' };
    case 'recovering':
      return { status: 'unreachable', detailCode: 'connection_unavailable' };
    case 'unhealthy':
      return state.health.verdict === 'absent'
        ? { status: 'error', detailCode: 'sandbox_failed' }
        : { status: 'stopping', detailCode: 'sandbox_stopping' };
    case 'healthy':
      break;
  }

  // The canonical health deadline is the single source: before it fires the
  // aggregate is still healthy, but the public detail asks for a check.
  if (now >= state.health.deadlineAt) {
    return { status: 'unreachable', detailCode: 'check_needed' };
  }
  if (state.health.lastHeartbeat.ready) {
    return { status: 'active', detailCode: 'sandbox_ready' };
  }
  return { status: 'starting', detailCode: 'sandbox_starting' };
}
