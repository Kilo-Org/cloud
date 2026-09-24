/**
 * Allocation orchestration loop. It owns the controller instance and the
 * `dispatch → run commands → feed results back as events → until no commands`
 * cycle; the caller supplies the effect port and the clock. It makes no
 * transition decision: every state change is the controller's reducer.
 *
 * This is the module the DO wires in place of the flat allocation path. The
 * loop is bounded so a reducer/runner pair that re-emitted forever cannot spin a
 * DO indefinitely; the bound is a safety rail, not a policy.
 */
import type { Command } from '../sandbox-state/commands.js';
import type { AllocationInputEvent } from '../sandbox-state/events.js';
import type { CanonicalStorage } from '../sandbox-state/persist/store.js';
import {
  createAllocationController,
  type AllocationController,
  type AllocationDecision,
} from './allocation-controller.js';
import type { AllocationTransition } from './allocation-transition.js';
import { runCommands, type ControlEffectPort } from './control-effects.js';

export type ControlOrchestratorDeps = {
  storage: CanonicalStorage;
  effects: ControlEffectPort;
  now?: () => number;
  resumable?: boolean;
  /**
   * The single deferral predicate for recovery attempts: while it reports a
   * reconnectable/coming-up wrapper, `runCommands` skips `Reconcile` commands so
   * the episode and its absolute deadline stay intact. The runner owns the
   * decision; this predicate only reports the connection state.
   */
  shouldDeferRecovery?: () => boolean;
  /** Bound on dispatch→run cycles; guards a reducer/runner that re-emits forever. */
  maxSteps?: number;
  /**
   * Optional wrapper around each feedback dispatch in the drain loop. The DO
   * uses it to bind a durable projection (the E2B lifetime reason) to the
   * accepted decision in the same storage transaction. It must return the
   * dispatch's decision unchanged: swallowing it stalls the loop.
   */
  wrapDispatch?: (
    event: AllocationInputEvent,
    dispatch: () => Promise<AllocationDecision | undefined>
  ) => Promise<AllocationDecision | undefined>;
  /** Optional sink for each committed, non-no-op transition the controller reports. */
  onTransition?: (transition: AllocationTransition) => void;
};

export type ControlOrchestrator = {
  readonly controller: AllocationController;
  /** One reducer step: dispatch an event, run nothing. */
  dispatch(event: AllocationInputEvent, now?: number): Promise<AllocationDecision | undefined>;
  /**
   * Execute a dispatched decision's commands through the port, feed each result
   * back to the controller, and repeat until the machine quiesces. It performs
   * no reducer step of its own: the caller uses this to interleave work between
   * the persisted decision (`dispatch`) and its effect execution — for example
   * session-credential preparation that must happen after `creating` is
   * persisted and before the create effect runs.
   */
  run(commands: readonly Command[], now?: number): Promise<void>;
  /** Dispatch an event, run every resulting command, feed the effect results back
   *  until the machine quiesces, and return the final decision. */
  settle(event: AllocationInputEvent, now?: number): Promise<AllocationDecision | undefined>;
};

const DEFAULT_MAX_STEPS = 16;

export function createControlOrchestrator(deps: ControlOrchestratorDeps): ControlOrchestrator {
  const clock = deps.now ?? (() => Date.now());
  const controller = createAllocationController({
    storage: deps.storage,
    now: deps.now,
    resumable: deps.resumable,
    onTransition: deps.onTransition,
  });
  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS;

  /**
   * Drain a queue of commands: run them, dispatch each result event, append the
   * new commands, until the queue empties or the bound trips. Returns the last
   * decision the controller produced.
   */
  async function drain(
    initial: readonly Command[],
    now: number
  ): Promise<AllocationDecision | undefined> {
    let queue = [...initial];
    let decision: AllocationDecision | undefined;
    let steps = 0;
    while (queue.length > 0 && steps < maxSteps) {
      steps += 1;
      const feedback = await runCommands(deps.effects, queue, now, deps.shouldDeferRecovery);
      queue = [];
      for (const resultEvent of feedback) {
        const next = await (deps.wrapDispatch
          ? deps.wrapDispatch(resultEvent, () => controller.dispatch(resultEvent, clock()))
          : controller.dispatch(resultEvent, clock()));
        if (next === undefined) continue;
        decision = next;
        queue.push(...next.commands);
      }
    }
    return decision;
  }

  return {
    controller,

    dispatch: (event, now) => controller.dispatch(event, now),

    async run(commands, now) {
      await drain(commands, now ?? clock());
    },

    async settle(event, now) {
      const decision = await controller.dispatch(event, now ?? clock());
      if (decision === undefined) return undefined;
      const final = await drain(decision.commands, clock());
      return final ?? decision;
    },
  };
}
