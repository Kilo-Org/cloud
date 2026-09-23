/**
 * Observation→event adapter for runtime health. It is **not** a state owner: it
 * only translates a connection-level observation into the canonical
 * `AllocationInputEvent` and dispatches it through the allocation controller, so
 * the single composition in `allocation/reduce.ts` (`delegatedHealth` +
 * `applyHealth`) stays the only place health transitions are decided.
 *
 * It never loads or persists the record and never calls `decideHealth` /
 * `applyHealth`; both would re-derive the composition in a second place.
 */
import type { AllocationInputEvent, ResultFence } from '../sandbox-state/events.js';
import type { HealthVerdict } from '../sandbox-state/model/health.js';
import type { AllocationDecision } from './allocation-controller.js';

export type HealthDispatcher = {
  dispatch(event: AllocationInputEvent, now?: number): Promise<AllocationDecision | undefined>;
};

/**
 * Connection-level observations. `handshake` and `socket-closed` both carry no
 * readiness evidence, so both map to `HEALTH_OBSERVED{unknown}`: in `connecting`
 * it records the observation without leaving the state, while in `healthy` it
 * starts bounded recovery. The state, not the adapter, chooses the consequence.
 */
export type HealthObservation =
  | { kind: 'handshake'; incarnation: string; at: number; expectedWrapperInstanceId?: string }
  | { kind: 'ready'; incarnation: string; at: number; expectedWrapperInstanceId?: string }
  | {
      kind: 'heartbeat';
      incarnation: string;
      at: number;
      ready: boolean;
      expectedWrapperInstanceId?: string;
    }
  | { kind: 'socket-closed'; incarnation: string; at: number; expectedWrapperInstanceId?: string }
  | { kind: 'unhealthy'; verdict: HealthVerdict }
  | { kind: 'check' }
  | { kind: 'observed'; fence: ResultFence; result: 'absent' | 'present' };

export function toAllocationEvent(observation: HealthObservation): AllocationInputEvent {
  switch (observation.kind) {
    case 'handshake':
    case 'socket-closed':
      return {
        type: 'HEALTH_OBSERVED',
        incarnation: observation.incarnation,
        at: observation.at,
        providerState: 'unknown',
        ...(observation.expectedWrapperInstanceId !== undefined
          ? { expectedWrapperInstanceId: observation.expectedWrapperInstanceId }
          : {}),
      };
    case 'ready':
      return {
        type: 'CONNECTED',
        incarnation: observation.incarnation,
        at: observation.at,
        ready: true,
        ...(observation.expectedWrapperInstanceId !== undefined
          ? { expectedWrapperInstanceId: observation.expectedWrapperInstanceId }
          : {}),
      };
    case 'heartbeat':
      return {
        type: 'HEARTBEAT',
        incarnation: observation.incarnation,
        at: observation.at,
        ready: observation.ready,
        ...(observation.expectedWrapperInstanceId !== undefined
          ? { expectedWrapperInstanceId: observation.expectedWrapperInstanceId }
          : {}),
      };
    case 'unhealthy':
      return { type: 'HEALTH_UNHEALTHY', verdict: observation.verdict };
    case 'check':
      return { type: 'CHECK' };
    case 'observed':
      return { type: 'OBSERVED', fence: observation.fence, result: observation.result };
  }
}

export type HealthController = {
  observe(observation: HealthObservation, now?: number): Promise<AllocationDecision | undefined>;
};

export function createHealthController(dispatcher: HealthDispatcher): HealthController {
  return {
    observe(observation, now) {
      return dispatcher.dispatch(toAllocationEvent(observation), now);
    },
  };
}
