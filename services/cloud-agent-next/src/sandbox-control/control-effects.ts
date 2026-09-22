/**
 * Allocation command runner. It executes the reducer's commands through an
 * injected `ControlEffectPort` and translates each result back into a canonical
 * event for the controller to dispatch. It makes no state decision: failure
 * mapping is fixed here (`command failure is an event, never an exception branch`),
 * and the reducer remains the only place a transition is chosen.
 *
 * The port is the I/O seam. C3b implements it over `ProviderAdapter` (create +
 * launch, stop, destroy, observe), the session stub (`NotifySession`) and
 * `ReconcilePort`.
 */
import type {
  Command,
  CreateCommand,
  DestroyCommand,
  LaunchCommand,
  ObserveCommand,
  NotifySessionCommand,
  ReconcileCommand,
  StopCommand,
} from '../sandbox-state/commands.js';
import type { AllocationInputEvent, RecoveryFence, ResultFence } from '../sandbox-state/events.js';
import type {
  AllocationContainment,
  AllocationTarget,
  StopProof,
} from '../sandbox-state/model/allocation.js';
import type { HealthRecoveryStep } from '../sandbox-state/model/health.js';

export type CreateEffectResult =
  | {
      outcome: 'confirmed';
      providerRef: string;
      incarnation: string;
      resolvedContainment?: AllocationContainment;
    }
  | { outcome: 'failed'; reason: string }
  | { outcome: 'unknown'; reason: string };

export type StopEffectResult =
  | { outcome: 'terminal'; incarnation: string; wrapper?: string }
  | { outcome: 'retryable'; detail?: string };

export type LaunchEffectResult = { outcome: 'confirmed' } | { outcome: 'failed'; reason: string };

export type ObserveEffectResult = {
  outcome: 'absent' | 'present';
  providerRef: string | null;
  incarnation: string;
  recoverable?: boolean;
  resolvedContainment?: AllocationContainment;
};

export type ReconcileEffectResult =
  | { outcome: 'succeeded'; at: number; ready: boolean }
  | { outcome: 'step'; step: HealthRecoveryStep }
  | { outcome: 'attempt-failed' };

export type NotifyEffectResult = { outcome: 'delivered' } | { outcome: 'failed'; reason: string };

export type ControlEffectPort = {
  create(command: CreateCommand): Promise<CreateEffectResult>;
  launch(command: LaunchCommand): Promise<LaunchEffectResult>;
  stop(command: StopCommand): Promise<StopEffectResult>;
  destroy(command: DestroyCommand): Promise<StopEffectResult>;
  observe(command: ObserveCommand): Promise<ObserveEffectResult>;
  reconcile(command: ReconcileCommand): Promise<ReconcileEffectResult>;
  notifySession(command: NotifySessionCommand): Promise<NotifyEffectResult>;
};

function fence(
  operationId: string,
  providerRef: string | null,
  incarnation: string | null
): ResultFence {
  return { operationId, providerRef, incarnation };
}

function recoveryFence(command: ReconcileCommand): RecoveryFence {
  return {
    incarnation: command.incarnation,
    episodeId: command.recovery.episodeId,
    attempt: command.attempt,
    operationId: command.operationId,
  };
}

function stopProof(
  target: AllocationTarget,
  reason: string,
  effect: 'stop' | 'destroy',
  incarnation: string,
  wrapper: string | undefined,
  now: number
): StopProof {
  return {
    effect,
    at: now,
    providerRef: target.providerRef,
    ...(target.allocationName !== undefined ? { allocationName: target.allocationName } : {}),
    incarnation,
    ...(wrapper !== undefined ? { wrapper } : {}),
    reason,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Execute one command. Returns the event to feed back, or `undefined` when the
 * command has no result event (`NotifySession`) or its effect could not produce
 * one (`Observe` failure; the deadline re-drives it). Never throws: a port
 * failure is mapped to the command's retryable/unknown event.
 */
export async function executeCommand(
  port: ControlEffectPort,
  command: Command,
  now: number
): Promise<AllocationInputEvent | undefined> {
  switch (command.kind) {
    case 'Create': {
      try {
        const result = await port.create(command);
        if (result.outcome === 'confirmed') {
          return {
            type: 'CREATE_CONFIRMED',
            fence: fence(command.operationId, result.providerRef, result.incarnation),
            providerRef: result.providerRef,
            incarnation: result.incarnation,
            at: now,
            ...(result.resolvedContainment !== undefined
              ? { resolvedContainment: result.resolvedContainment }
              : {}),
          };
        }
        if (result.outcome === 'failed') {
          return {
            type: 'CREATE_FAILED',
            fence: fence(command.operationId, command.target.providerRef, null),
            reason: result.reason,
            at: now,
          };
        }
        return {
          type: 'CREATE_UNKNOWN',
          fence: fence(command.operationId, command.target.providerRef, null),
          reason: result.reason,
          at: now,
        };
      } catch (error) {
        return {
          type: 'CREATE_UNKNOWN',
          fence: fence(command.operationId, command.target.providerRef, null),
          reason: errorMessage(error),
          at: now,
        };
      }
    }

    case 'Launch': {
      try {
        const result = await port.launch(command);
        if (result.outcome === 'confirmed') return undefined;
        return {
          type: 'LAUNCH_FAILED',
          fence: fence(command.operationId, command.target.providerRef, command.incarnation),
          reason: result.reason,
          at: now,
        };
      } catch (error) {
        return {
          type: 'LAUNCH_FAILED',
          fence: fence(command.operationId, command.target.providerRef, command.incarnation),
          reason: errorMessage(error),
          at: now,
        };
      }
    }

    case 'Stop':
    case 'Destroy': {
      // Failure events must carry the originating incarnation so the reducer's
      // stop fence accepts them and the retry budget advances. A missing
      // incarnation (legacy record) stays `null`, which the reducer does not
      // compare, preserving stale-result fencing when it is known.
      const origin = command.incarnation ?? null;
      try {
        const result =
          command.kind === 'Stop' ? await port.stop(command) : await port.destroy(command);
        if (result.outcome === 'retryable') {
          return {
            type: 'DESTROY_NOT_CONFIRMED',
            fence: fence(command.operationId, command.target.providerRef, origin),
            ...(result.detail !== undefined ? { detail: result.detail } : {}),
          };
        }
        // A successful confirmation preserves the *returned* evidence. If the
        // port reports a different incarnation than the command expected, the
        // reducer must see the mismatch and reject it; overwriting it with the
        // expected value would let a foreign stop settle as proof.
        const incarnation = result.incarnation ?? command.incarnation;
        return {
          type: 'DESTROY_CONFIRMED',
          fence: fence(command.operationId, command.target.providerRef, incarnation),
          proof: stopProof(
            command.target,
            command.reason,
            command.kind === 'Destroy' ? 'destroy' : 'stop',
            incarnation,
            result.wrapper,
            now
          ),
        };
      } catch (error) {
        return {
          type: 'DESTROY_NOT_CONFIRMED',
          fence: fence(command.operationId, command.target.providerRef, origin),
          detail: errorMessage(error),
        };
      }
    }

    case 'Observe': {
      try {
        const result = await port.observe(command);
        // Keep the observed incarnation; a mismatch with the stop intent is a
        // stale/foreign observation and the reducer rejects it.
        return {
          type: 'OBSERVED',
          fence: fence(
            command.operationId,
            result.providerRef,
            result.incarnation ?? command.incarnation
          ),
          result: result.outcome,
          ...(result.recoverable === true ? { recoverable: true } : {}),
          ...(result.resolvedContainment !== undefined
            ? { resolvedContainment: result.resolvedContainment }
            : {}),
        };
      } catch {
        // No "observation failed" event exists; the state deadline re-drives it.
        return undefined;
      }
    }

    case 'Reconcile': {
      try {
        const result = await port.reconcile(command);
        if (result.outcome === 'succeeded') {
          return {
            type: 'RECOVERY_SUCCEEDED',
            fence: recoveryFence(command),
            at: result.at,
            ready: result.ready,
          };
        }
        if (result.outcome === 'step') {
          return { type: 'RECOVERY_STEP', fence: recoveryFence(command), step: result.step };
        }
        return { type: 'RECOVERY_ATTEMPT_FAILED', fence: recoveryFence(command) };
      } catch {
        return { type: 'RECOVERY_ATTEMPT_FAILED', fence: recoveryFence(command) };
      }
    }

    case 'NotifySession': {
      try {
        await port.notifySession(command);
      } catch {
        // Notification failures are retried inside the port within its bounded
        // budget; the allocation settles regardless and the seam ignores a
        // duplicate/replayed STOPPED.
      }
      return undefined;
    }

    case 'Acquire':
      // The allocation reducer emits `Create` for ACQUIRE; no Acquire command is
      // ever produced. Kept exhaustive rather than throwing.
      return undefined;
  }
}

/**
 * Run a decision's commands.
 *
 * Ordering/concurrency: `NotifySession` commands are dispatched **immediately**
 * and independently of provider-effect completion — a slow or unresolved
 * stop/destroy must not delay notifying an already-fenced session. The
 * remaining (effect) commands run sequentially in decision order; their events
 * are returned in that order. Notification calls produce no events and are
 * awaited only after the effects finish, so a notification failure can never
 * mask an effect result.
 *
 * Recovery deferral: this runner is the single owner of the deferral decision.
 * While `shouldDeferRecovery()` reports a reconnectable/coming-up wrapper, a
 * `Reconcile` command is not attempted and feeds no event, so the episode and
 * its absolute deadline stay intact and the next alarm (or the reconnecting
 * wrapper) re-drives it. Expiry still stops the allocation.
 */
export async function runCommands(
  port: ControlEffectPort,
  commands: readonly Command[],
  now: number,
  shouldDeferRecovery?: () => boolean
): Promise<AllocationInputEvent[]> {
  const notifications = commands
    .filter(command => command.kind === 'NotifySession')
    .map(command => executeCommand(port, command, now));
  const events: AllocationInputEvent[] = [];
  for (const command of commands) {
    if (command.kind === 'NotifySession') continue;
    if (command.kind === 'Reconcile' && shouldDeferRecovery?.() === true) continue;
    const event = await executeCommand(port, command, now);
    if (event !== undefined) events.push(event);
  }
  await Promise.all(notifications);
  return events;
}
