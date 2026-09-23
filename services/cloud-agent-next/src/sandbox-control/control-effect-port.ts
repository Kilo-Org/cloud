/**
 * Inert implementation of C3a's `ControlEffectPort` over injected dependencies:
 * a provider effect function set (`create`, `launch`, `stop`, `destroy`,
 * `observe`), a `NotifySessionPort`, and the C2 `ReconcilePort`. It executes the
 * allocation commands and returns effect results; it makes no state decision and
 * holds no storage. `create` only allocates the provider instance; the reducer
 * emits a separate `Launch` command once the reference is confirmed, so the
 * wrapper launch never precedes the durable confirmation. C3b binds the real
 * `ProviderAdapter`, the session stub and `ReconcilePort` and no longer needs new
 * logic there.
 */
import type {
  CreateCommand,
  DestroyCommand,
  LaunchCommand,
  NotifySessionCommand,
  ObserveCommand,
  ReconcileCommand,
  StopCommand,
} from '../sandbox-state/commands.js';
import type {
  AllocationContainment,
  AllocationTarget,
  StopProof,
} from '../sandbox-state/model/allocation.js';
import type { ReconcilePort } from '../sandbox-state/ports/reconcile.js';
import type { ObserveResult, StopResult } from './provider.js';
import type {
  ControlEffectPort,
  CreateEffectResult,
  LaunchEffectResult,
  NotifyEffectResult,
  ObserveEffectResult,
  ReconcileEffectResult,
  StopEffectResult,
} from './control-effects.js';

/** The session-stub RPC shape C3b wires to the concrete session stub. */
export type NotifySessionPort = {
  notifyStopped(input: {
    stopProof: StopProof | undefined;
    reason: string;
  }): Promise<NotifyEffectResult>;
};

/** The provider result of a create effect, with the incarnation it confirmed. */
export type ControlEffectCreateResult =
  | { providerRef: string; incarnation: string; resolvedContainment?: AllocationContainment }
  | { unresolved: true };

export type ControlEffectStopResult = {
  result: StopResult;
  incarnation: string;
  wrapper?: string;
};

export type ControlEffectObserveResult = {
  status: ObserveResult;
  providerRef: string | null;
  incarnation: string;
};

/**
 * A provider effect function set. `stop`/`destroy`/`observe` receive the
 * originating incarnation from the command so the binding can fence the effect;
 * the returned incarnation is the observed one and is never substituted here.
 */
export type ControlEffectProvider = {
  create(input: { target: AllocationTarget; intentId: string }): Promise<ControlEffectCreateResult>;
  launch(input: { providerRef: string; target: AllocationTarget }): Promise<void>;
  stop(input: {
    target: AllocationTarget;
    reason: string;
    incarnation?: string;
  }): Promise<ControlEffectStopResult>;
  destroy(input: {
    target: AllocationTarget;
    reason: string;
    incarnation?: string;
  }): Promise<ControlEffectStopResult>;
  observe(input: {
    target: AllocationTarget;
    incarnation?: string;
  }): Promise<ControlEffectObserveResult>;
};

export type ControlEffectPortDeps = {
  provider: ControlEffectProvider;
  notifySession: NotifySessionPort;
  reconcile: ReconcilePort;
  now?: () => number;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createControlEffectPort(deps: ControlEffectPortDeps): ControlEffectPort {
  const clock = deps.now ?? (() => Date.now());

  async function runStopOrDestroy(
    command: StopCommand | DestroyCommand
  ): Promise<StopEffectResult> {
    try {
      const input = {
        target: command.target,
        reason: command.reason,
        ...(command.incarnation !== undefined ? { incarnation: command.incarnation } : {}),
      };
      const effect =
        command.kind === 'Stop'
          ? await deps.provider.stop(input)
          : await deps.provider.destroy(input);
      if (effect.result === 'retryable') return { outcome: 'retryable' };
      return {
        outcome: 'terminal',
        incarnation: effect.incarnation,
        ...(effect.wrapper !== undefined ? { wrapper: effect.wrapper } : {}),
      };
    } catch (error) {
      return { outcome: 'retryable', detail: errorMessage(error) };
    }
  }

  return {
    async create(command: CreateCommand): Promise<CreateEffectResult> {
      try {
        const created = await deps.provider.create({
          target: command.target,
          intentId: command.intentId,
        });
        if ('unresolved' in created) return { outcome: 'unknown', reason: 'create_unresolved' };
        return {
          outcome: 'confirmed',
          providerRef: created.providerRef,
          incarnation: created.incarnation,
          ...(created.resolvedContainment !== undefined
            ? { resolvedContainment: created.resolvedContainment }
            : {}),
        };
      } catch (error) {
        return { outcome: 'unknown', reason: errorMessage(error) };
      }
    },

    async launch(command: LaunchCommand): Promise<LaunchEffectResult> {
      const providerRef = command.target.providerRef;
      if (providerRef === null) {
        return { outcome: 'failed', reason: 'launch_without_provider_ref' };
      }
      try {
        await deps.provider.launch({ providerRef, target: command.target });
        return { outcome: 'confirmed' };
      } catch (error) {
        return { outcome: 'failed', reason: errorMessage(error) };
      }
    },

    stop(command: StopCommand): Promise<StopEffectResult> {
      return runStopOrDestroy(command);
    },

    destroy(command: DestroyCommand): Promise<StopEffectResult> {
      return runStopOrDestroy(command);
    },

    async observe(command: ObserveCommand): Promise<ObserveEffectResult> {
      const observed = await deps.provider.observe({
        target: command.target,
        ...(command.incarnation !== undefined ? { incarnation: command.incarnation } : {}),
      });
      // `unknown` is an inconclusive observation, not absence or presence. The
      // runner drops the thrown failure and the state deadline re-drives it.
      if (observed.status === 'unknown') throw new Error('observation_inconclusive');
      return {
        outcome: observed.status === 'terminal' ? 'absent' : 'present',
        providerRef: observed.providerRef,
        incarnation: observed.incarnation,
      };
    },

    async reconcile(command: ReconcileCommand): Promise<ReconcileEffectResult> {
      // One attempt-wide descriptor: the wire calls of a single attempt all carry
      // the command's own `(episodeId, attempt, deadlineAt)`, and only a new
      // reducer command changes it. The descriptor is sent verbatim; nothing is
      // substituted for a missing value.
      const attempt = {
        expectedWrapperInstanceId: command.expectedWrapperInstanceId,
        episodeId: command.recovery.episodeId,
        attempt: command.attempt,
        deadlineAt: command.deadlineAt,
      };
      try {
        // The wrapper records the active recovery only on a `drain`, and fences
        // every other phase on the recorded tuple, so a `ready` command must
        // re-establish its own tuple with a `drain` first. Never deduped: the
        // wrapper's reconcile handler is idempotent across phases.
        if (command.phase === 'ready') {
          await deps.reconcile.sendPhase({
            ...attempt,
            recovery: command.recovery,
            phase: 'drain',
          });
        }
        await deps.reconcile.sendPhase({
          ...attempt,
          recovery: command.recovery,
          phase: command.phase,
        });
        const ready = await deps.reconcile.probeReady(attempt);
        if (ready) {
          await deps.reconcile.sendPhase({
            ...attempt,
            recovery: command.recovery,
            phase: 'commit',
          });
          return { outcome: 'succeeded', at: clock(), ready: true };
        }
        // A completed-but-not-ready drain rung advances the ladder; any other
        // not-ready result, throw or ack mismatch fails the attempt.
        if (command.phase === 'drain') return { outcome: 'step', step: 'reconnect_wrapper' };
        return { outcome: 'attempt-failed' };
      } catch {
        return { outcome: 'attempt-failed' };
      }
    },

    async notifySession(command: NotifySessionCommand): Promise<NotifyEffectResult> {
      try {
        return await deps.notifySession.notifyStopped({
          stopProof: command.stopProof,
          reason: command.reason,
        });
      } catch (error) {
        return { outcome: 'failed', reason: errorMessage(error) };
      }
    },
  };
}
