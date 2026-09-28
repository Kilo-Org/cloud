/**
 * States × events registry. This is data for tests and the projection, not a
 * runtime engine: the reducers are the engine. It aggregates the declarative
 * tables each reducer exports so the invariants in plan C1 can be checked without
 * duplicating the transition list.
 *
 * `allocated` owns its own transitions only; the health edges it delegates are
 * composed here from `HEALTH_TRANSITIONS` and the one health→allocation mapping,
 * so the nested behaviour is not copied into the allocation table.
 */
import type { CommandKind } from './commands.js';
import {
  ALLOCATION,
  ALLOCATION_EVENT_TYPES,
  ALLOCATION_OWNED_FIELDS,
  ALLOCATION_STATES,
  ALLOCATION_TRANSITIONS,
} from './allocation/reduce.js';
import {
  HEALTH,
  HEALTH_EVENT_TYPES,
  HEALTH_OWNED_FIELDS,
  HEALTH_STATES,
  HEALTH_TRANSITIONS,
} from './health/reduce.js';
import {
  SESSION,
  SESSION_EVENT_TYPES,
  SESSION_OWNED_FIELDS,
  SESSION_STATES,
  SESSION_TRANSITIONS,
} from './session/reduce.js';

export type DeadlineKind =
  | 'create'
  | 'heartbeat'
  | 'connect'
  | 'recovery'
  | 'observe'
  | 'destroy'
  | 'delivery'
  | 'cancel'
  | 'health'
  | null;

/** Declarative state metadata used by the registry and projection. */
export type StateMeta = {
  kind: string;
  terminal: boolean;
  hasDeadline: boolean;
  /** Named (demand-driven) exits for a state that has no automatic deadline. */
  namedExits: readonly string[];
};

/** Declarative transition metadata. A missing entry is an explicit rejection. */
export type TransitionMeta = {
  from: string;
  event: string;
  to: string;
  commands: readonly CommandKind[];
  deadline: DeadlineKind;
};

export type MachineName = 'allocation' | 'health' | 'session';

export type MachineRegistry = {
  name: MachineName;
  initial: string;
  /** Reducer entry states plus states a loader can produce (legacy migration). */
  entries: readonly string[];
  states: readonly StateMeta[];
  events: readonly string[];
  transitions: readonly TransitionMeta[];
  ownedFields: readonly string[];
};

/** Health `CANCEL` is registered under the allocation event key for the nested edge. */
const HEALTH_EVENT_ALIAS: Record<string, string> = { CANCEL: 'CANCEL.RECOVERY' };

/**
 * The verdict an unhealthy health transition carries. `HEALTH_UNHEALTHY` takes its
 * verdict from the event, so it maps to both allocation outcomes.
 */
const UNHEALTHY_VERDICT: Record<string, 'absent' | 'unresponsive' | 'both'> = {
  HEALTH_OBSERVED: 'absent',
  HEALTH_UNHEALTHY: 'both',
  CANCEL: 'unresponsive',
  RECOVERY_STEP: 'unresponsive',
  RECOVERY_ATTEMPT_FAILED: 'unresponsive',
};

const EFFECT_AND_NOTIFY: readonly CommandKind[] = ['Stop', 'Destroy', 'NotifySession'];

/** Compose the `allocated.*` edges the allocation counter delegates to health. */
function nestedAllocationTransitions(): TransitionMeta[] {
  const transitions: TransitionMeta[] = [];
  for (const transition of HEALTH_TRANSITIONS) {
    // DEADLINE is dispatched by allocation (idle anchor first), not delegated.
    if (transition.event === 'DEADLINE') continue;
    const event = HEALTH_EVENT_ALIAS[transition.event] ?? transition.event;
    const from = `allocated.${transition.from}`;
    if (transition.to !== 'unhealthy') {
      transitions.push({
        from,
        event,
        to: `allocated.${transition.to}`,
        commands: transition.commands,
        deadline: transition.deadline,
      });
      continue;
    }
    const verdict = UNHEALTHY_VERDICT[transition.event];
    if (verdict === 'absent' || verdict === 'both') {
      transitions.push({ from, event, to: 'stopped', commands: ['NotifySession'], deadline: null });
    }
    if (verdict === 'unresponsive' || verdict === 'both') {
      transitions.push({
        from,
        event,
        to: 'stopping.destroying',
        commands: EFFECT_AND_NOTIFY,
        deadline: 'destroy',
      });
    }
  }
  return transitions;
}

export const ALLOCATION_REGISTRY: MachineRegistry = {
  name: ALLOCATION,
  initial: 'stopped',
  entries: ['stopped'],
  states: ALLOCATION_STATES,
  events: ALLOCATION_EVENT_TYPES,
  transitions: [...ALLOCATION_TRANSITIONS, ...nestedAllocationTransitions()],
  ownedFields: ALLOCATION_OWNED_FIELDS,
};

export const HEALTH_REGISTRY: MachineRegistry = {
  name: HEALTH,
  initial: 'connecting',
  entries: ['connecting'],
  states: HEALTH_STATES,
  events: HEALTH_EVENT_TYPES,
  transitions: HEALTH_TRANSITIONS,
  ownedFields: HEALTH_OWNED_FIELDS,
};

export const SESSION_REGISTRY: MachineRegistry = {
  name: SESSION,
  initial: 'unbound',
  // `unresolved` is produced only by legacy migration, never by a reducer event.
  entries: ['unbound', 'unresolved'],
  states: SESSION_STATES,
  events: SESSION_EVENT_TYPES,
  transitions: SESSION_TRANSITIONS,
  ownedFields: SESSION_OWNED_FIELDS,
};

export const REGISTRY: readonly MachineRegistry[] = [
  ALLOCATION_REGISTRY,
  HEALTH_REGISTRY,
  SESSION_REGISTRY,
];

export type PairDisposition = 'handled' | 'rejected';

export function pairDisposition(
  machine: MachineRegistry,
  stateKind: string,
  event: string
): PairDisposition {
  return machine.transitions.some(
    transition => transition.from === stateKind && transition.event === event
  )
    ? 'handled'
    : 'rejected';
}

export function transitionsFor(
  machine: MachineRegistry,
  stateKind: string,
  event: string
): readonly TransitionMeta[] {
  return machine.transitions.filter(
    transition => transition.from === stateKind && transition.event === event
  );
}

/** Every state key of a machine, including `stopping.*` composite keys. */
export function stateKinds(machine: MachineRegistry): string[] {
  return machine.states.map(state => state.kind);
}

/** Reachable state kinds from every entry state over handled transitions. */
export function reachableStates(machine: MachineRegistry): Set<string> {
  const reachable = new Set<string>(machine.entries);
  const queue = [...machine.entries];
  for (const current of queue) {
    for (const transition of machine.transitions) {
      if (transition.from !== current) continue;
      if (reachable.has(transition.to)) continue;
      reachable.add(transition.to);
      queue.push(transition.to);
    }
  }
  return reachable;
}
