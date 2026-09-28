/**
 * Commands are data. The reducer emits them; a thin runner executes them and feeds
 * the result back as an event. Every command carries an `operationId` so a retried
 * effect is idempotent.
 */
import type { AllocationTarget, StopProof } from './model/allocation.js';
import type { SandboxRecovery } from '../shared/sandbox-control-protocol.js';
import type { ReconcilePhase } from './ports/reconcile.js';

export type OperationId = string;

export type CommandKind =
  | 'Create'
  | 'Launch'
  | 'Stop'
  | 'Destroy'
  | 'Observe'
  | 'Reconcile'
  | 'NotifySession'
  | 'Acquire';

export type CreateCommand = {
  kind: 'Create';
  operationId: OperationId;
  target: AllocationTarget;
  intentId: string;
};

/**
 * Start the wrapper for an already-confirmed allocation. Emitted by
 * `CREATE_CONFIRMED` so the provider reference is durably visible before the
 * wrapper can launch; a failure is a distinct `LAUNCH_FAILED` result that keeps
 * the reference.
 */
export type LaunchCommand = {
  kind: 'Launch';
  operationId: OperationId;
  target: AllocationTarget;
  incarnation: string;
};

export type StopCommand = {
  kind: 'Stop';
  operationId: OperationId;
  target: AllocationTarget;
  reason: string;
  /** Originating allocation incarnation; fences the stop result against a stale attempt. */
  incarnation?: string;
};

export type DestroyCommand = {
  kind: 'Destroy';
  operationId: OperationId;
  target: AllocationTarget;
  reason: string;
  /** Originating allocation incarnation; fences the stop result against a stale attempt. */
  incarnation?: string;
};

export type ObserveCommand = {
  kind: 'Observe';
  operationId: OperationId;
  target: AllocationTarget;
  /** Originating allocation incarnation; fences the observation against a stale attempt. */
  incarnation?: string;
};

/**
 * Health-owned recovery operation. The reducer emits it when recovery is entered
 * or advances; the runner executes one attempt and feeds the result back.
 */
export type ReconcileCommand = {
  kind: 'Reconcile';
  operationId: OperationId;
  incarnation: string;
  attempt: number;
  /** Absolute recovery deadline shared by all attempts; never extended. */
  deadlineAt: number;
  /** Episode descriptor sent verbatim on the wire; built only by `reconcileCommand`. */
  recovery: SandboxRecovery;
  /** Ladder step this attempt executes; `commit` is never a command phase. */
  phase: ReconcilePhase;
  expectedWrapperInstanceId?: string;
};

export type NotifySessionCommand = {
  kind: 'NotifySession';
  operationId: OperationId;
  reason: string;
  stopProof?: StopProof;
};

export type AcquireCommand = {
  kind: 'Acquire';
  operationId: OperationId;
  requestId: string;
  deliveryDeadlineAt: number;
};

export type Command =
  | CreateCommand
  | LaunchCommand
  | StopCommand
  | DestroyCommand
  | ObserveCommand
  | ReconcileCommand
  | NotifySessionCommand
  | AcquireCommand;

export type Decision<T> = {
  state: T;
  commands: Command[];
  deadlineAt: number | null;
};

/** Stable, pure operation id derived from the transition identity. */
export function operationId(...parts: ReadonlyArray<string | number>): OperationId {
  return parts.join(':');
}
