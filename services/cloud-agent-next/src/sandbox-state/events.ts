/**
 * Every event the three machines accept, including the `CANCEL{scope}` event and
 * the cross-aggregate seam events `ACQUIRE` (session → allocation) and `STOPPED`
 * (allocation → session).
 *
 * Events are not persisted, so they are plain discriminated unions. A machine
 * rejects an event it does not list here for the current state by returning
 * `undefined`; there is no silent no-op.
 *
 * Every allocation result event carries a `ResultFence`: the operation id of the
 * command it completes plus the provider reference it observed. The reducer
 * rejects a result whose operation id or reference does not match the outstanding
 * effect, so a stale completion cannot mutate the aggregate.
 */
import type {
  AllocationContainment,
  AllocationCreateIntent,
  AllocationTarget,
  StopProof,
} from './model/allocation.js';
import type { HealthRecoveryStep, HealthVerdict } from './model/health.js';
import type {
  CloudAgentAssistantFailureReason,
  CloudAgentProviderOwnership,
  GateResult,
  MessageProofs,
  RuntimeHandle,
  SessionMessage,
  SessionMessageTerminalSource,
} from './model/session.js';

export type AllocationCancelEvent = {
  type: 'CANCEL';
  scope: 'allocation';
  reason?: string;
};

export type HealthCancelEvent = {
  type: 'CANCEL';
  scope: 'recovery';
  reason?: string;
};

export type SessionCancelEvent = {
  type: 'CANCEL';
  scope: 'message';
  messageId: string;
  at: number;
  reason?: string;
  /** Cancellation intent id; derived when the caller does not supply one. */
  operationId?: string;
  /** When an ambiguous dispatch must be reconciled by; derived when absent. */
  deadlineAt?: number;
};

/** Uniform fence for an allocation result event. */
export type ResultFence = {
  operationId: string;
  providerRef: string | null;
  /** Allocation incarnation the result belongs to; `null` when not yet known. */
  incarnation: string | null;
};

export type DemandEvent = {
  type: 'DEMAND';
  requestId: string;
  target: AllocationTarget;
  createIntent: AllocationCreateIntent | null;
};

/** Session → allocation seam. One request binds to one allocation. */
export type AcquireEvent = {
  type: 'ACQUIRE';
  requestId: string;
  target: AllocationTarget;
  createIntent: AllocationCreateIntent | null;
  deliveryDeadlineAt: number;
};

export type AllocationEvent =
  | DemandEvent
  | AcquireEvent
  | {
      type: 'CREATE_CONFIRMED';
      fence: ResultFence;
      /** The confirmed provider reference; replaces the unresolved target ref. */
      providerRef: string;
      incarnation: string;
      at: number;
      resolvedContainment?: AllocationContainment;
    }
  | { type: 'CREATE_FAILED'; fence: ResultFence; reason: string; at: number }
  | { type: 'CREATE_UNKNOWN'; fence: ResultFence; reason: string; at: number }
  | { type: 'LAUNCH_FAILED'; fence: ResultFence; reason: string; at: number }
  | { type: 'HEALTH_UNHEALTHY'; verdict: HealthVerdict }
  | { type: 'DESTROY_CONFIRMED'; fence: ResultFence; proof: StopProof }
  | { type: 'DESTROY_NOT_CONFIRMED'; fence: ResultFence; detail?: string }
  | { type: 'BUDGET_EXHAUSTED' }
  | { type: 'IDLE'; idleAt: number }
  | { type: 'CHECK' }
  | { type: 'OBSERVED'; fence: ResultFence; result: 'absent' | 'present' }
  | AllocationCancelEvent
  | { type: 'DEADLINE'; episodeId?: string };

/**
 * Fence for a recovery attempt result. `episodeId` is the stored uuid episode
 * identity (stable across the episode's attempts), `attempt` is the 1-based
 * attempt within the episode, and `operationId` is the `Reconcile` command the
 * result completes. The absolute deadline is deliberately not the identity: two
 * episodes accepted at the same timestamp would otherwise share a fence.
 */
export type RecoveryFence = {
  incarnation: string;
  episodeId: string;
  attempt: number;
  operationId: string;
};

export type HealthEvent =
  | {
      type: 'CONNECTED';
      incarnation: string;
      at: number;
      ready: boolean;
      episodeId?: string;
      expectedWrapperInstanceId?: string;
    }
  | {
      type: 'HEARTBEAT';
      incarnation: string;
      at: number;
      ready: boolean;
      episodeId?: string;
      expectedWrapperInstanceId?: string;
    }
  | {
      type: 'HEALTH_OBSERVED';
      incarnation: string;
      at: number;
      providerState: 'active' | 'terminal' | 'unknown';
      episodeId?: string;
      expectedWrapperInstanceId?: string;
    }
  | { type: 'RECOVERY_STEP'; fence: RecoveryFence; step: HealthRecoveryStep }
  | { type: 'RECOVERY_ATTEMPT_FAILED'; fence: RecoveryFence }
  | { type: 'RECOVERY_SUCCEEDED'; fence: RecoveryFence; at: number; ready: boolean }
  | { type: 'HEALTH_UNHEALTHY'; verdict: HealthVerdict }
  | HealthCancelEvent
  | { type: 'DEADLINE'; episodeId?: string };

/**
 * Events the allocation machine accepts. In `allocated` it delegates `HealthEvent`s
 * to the health submachine and maps an `unhealthy` verdict to the allocation
 * transition from design §6.
 */
export type AllocationInputEvent = AllocationEvent | HealthEvent;

export type EnqueueEvent = {
  type: 'ENQUEUE';
  message: SessionMessage;
};

export type BindEvent = { type: 'BIND'; handle: RuntimeHandle };

export type UnbindEvent = { type: 'UNBIND' };

export type SessionDemandEvent = {
  type: 'DEMAND';
  requestId: string;
  deliveryDeadlineAt: number;
};

export type AcceptEvent = {
  type: 'ACCEPT';
  messageId: string;
  acceptedAt: number;
  wrapperInstanceId?: string;
  executionDeadlineAt?: number;
  capAt?: number;
};

export type DeliveryStepEvent = {
  type: 'DELIVERY_STEP';
  messageId: string;
  step: 'waiting' | 'preparing';
  preparationAttemptId?: string;
  preparationWait?: { step: string; message: string };
  retryNotBefore?: number;
};

export type RecordProofEvent = {
  type: 'RECORD_PROOF';
  messageId: string;
  proofs: MessageProofs;
};

export type RecordCancellationEvent = {
  type: 'RECORD_CANCELLATION';
  messageId: string;
  operationId: string;
  deadlineAt: number;
};

export type OutcomeEvent = {
  type: 'OUTCOME';
  messageId: string;
  status: 'completed' | 'failed' | 'cancelled';
  at: number;
  source: SessionMessageTerminalSource;
  reason?: string;
  detail?: string;
  result?: unknown;
  assistantMessageId?: string;
  gateResult?: GateResult;
  assistantReason?: CloudAgentAssistantFailureReason;
  providerOwnership?: CloudAgentProviderOwnership;
};

/** Allocation → session seam. Delivered by the allocation command runner. */
export type StoppedEvent = {
  type: 'STOPPED';
  proof: StopProof;
  reason: string;
};

export type SessionEvent =
  | EnqueueEvent
  | BindEvent
  | UnbindEvent
  | SessionDemandEvent
  | AcceptEvent
  | DeliveryStepEvent
  | RecordProofEvent
  | RecordCancellationEvent
  | OutcomeEvent
  | SessionCancelEvent
  | StoppedEvent
  | { type: 'DEADLINE' };

/**
 * True when the event is owned by the health submachine, not the allocation.
 * `DEADLINE` is excluded: allocation dispatches it (idle anchor first) before
 * delegating to health.
 */
export function isHealthEvent(event: AllocationInputEvent): event is HealthEvent {
  switch (event.type) {
    case 'CONNECTED':
    case 'HEARTBEAT':
    case 'HEALTH_OBSERVED':
    case 'RECOVERY_STEP':
    case 'RECOVERY_ATTEMPT_FAILED':
    case 'RECOVERY_SUCCEEDED':
    case 'HEALTH_UNHEALTHY':
      return true;
    case 'CANCEL':
      return event.scope === 'recovery';
    default:
      return false;
  }
}
