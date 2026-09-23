/**
 * Canonical allocation-transition record (design §10). The controller builds one
 * per committed decision that is not a pure no-op; the DO projects it into the
 * structured diagnostic line that is the allocation/health state history. This
 * module owns the record, its single builder, the no-op predicate and the
 * diagnostic projection.
 */
import type { Command } from '../sandbox-state/commands.js';
import type { AllocationInputEvent } from '../sandbox-state/events.js';
import type { AllocationRecord, AllocationState } from '../sandbox-state/model/allocation.js';
import { allocationStateKey } from '../sandbox-state/allocation/reduce.js';
import type { ControlDiagnosticFields } from './diagnostics.js';

export const ALLOCATION_AGGREGATE = 'allocation';
export const ALLOCATION_TRANSITION_EVENT = 'allocation_transition';

export type AllocationTransition = {
  aggregate: typeof ALLOCATION_AGGREGATE;
  from: string;
  to: string;
  event: string;
  deadline: number | null;
  at: number;
  allocationId?: string;
  incarnation?: string;
  reason?: string;
};

/** The create intent id of a non-terminal state; `stopped` has no intent. */
function createIntentId(state: AllocationState): string | undefined {
  switch (state.kind) {
    case 'creating':
    case 'allocated':
    case 'stopping':
      return state.createIntent.intentId;
    case 'unknown':
      return state.createIntent?.intentId;
    default:
      return undefined;
  }
}

function allocatedIncarnation(state: AllocationState): string | undefined {
  return state.kind === 'allocated' ? state.health.incarnation : undefined;
}

/** The stop reason of the state a transition settles into, when it has one. */
function stopReason(state: AllocationState): string | undefined {
  switch (state.kind) {
    case 'stopping':
      return state.stopIntent.reason;
    case 'unknown':
      return state.stopIntent?.reason;
    case 'stopped':
      return state.summary?.stopProof?.reason;
    default:
      return undefined;
  }
}

export function buildAllocationTransition(
  from: AllocationRecord,
  to: AllocationRecord,
  event: AllocationInputEvent,
  deadlineAt: number | null,
  at: number
): AllocationTransition {
  return {
    aggregate: ALLOCATION_AGGREGATE,
    from: allocationStateKey(from.state),
    to: allocationStateKey(to.state),
    event: event.type.toLowerCase(),
    deadline: deadlineAt,
    at,
    allocationId: createIntentId(to.state) ?? createIntentId(from.state),
    incarnation: allocatedIncarnation(to.state) ?? allocatedIncarnation(from.state),
    reason: stopReason(to.state),
  };
}

function sortedEntries(value: object): Array<[string, unknown]> {
  return Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

/** Order-independent structural comparison: equal values with reordered keys match. */
function structuralEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => structuralEqual(value, right[index]))
    );
  }
  const leftEntries = sortedEntries(left);
  const rightEntries = sortedEntries(right);
  if (leftEntries.length !== rightEntries.length) return false;
  return leftEntries.every(([key, value], index) => {
    const rightEntry = rightEntries[index];
    return (
      rightEntry !== undefined && rightEntry[0] === key && structuralEqual(value, rightEntry[1])
    );
  });
}

export function recordsEqual(left: AllocationRecord, right: AllocationRecord): boolean {
  return structuralEqual(left, right);
}

/**
 * Emit iff the decision is accepted and is not a pure no-op: the resulting
 * record is structurally equal to the loaded record and there are no commands.
 * Equal state labels are not sufficient to suppress — a heartbeat renewal keeps
 * `allocated.healthy` while rewriting evidence, and a retry returns commands
 * with an unchanged record.
 */
export function allocationTransitionChanged(
  from: AllocationRecord,
  to: AllocationRecord,
  commands: readonly Command[]
): boolean {
  return commands.length > 0 || !recordsEqual(from, to);
}

export function allocationTransitionFields(t: AllocationTransition): ControlDiagnosticFields {
  return {
    aggregate: t.aggregate,
    from: t.from,
    to: t.to,
    event: t.event,
    deadline: t.deadline,
    at: t.at,
    allocationId: t.allocationId,
    incarnation: t.incarnation,
    reason: t.reason,
  };
}
