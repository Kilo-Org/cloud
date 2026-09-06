import {
  SANDBOX_CONTROL_CLEANUP_TIMEOUT_MS,
  type SessionRequestIdentity,
} from '../../../src/shared/sandbox-control-protocol.js';
import type { WrapperKiloClient } from '../kilo-api.js';
import { withTimeoutAndAbort } from '../utils.js';
import { withKiloRequestDeadline } from './sandbox-control-runtime.js';
import type { OwnedProcessScope } from './owned-processes.js';

export type NativeOperationTarget = Readonly<{
  runtimeId: string;
  client?: WrapperKiloClient;
}>;

export type NativeRetirement = 'retired' | 'stale' | 'unconfirmed';
export type NativeCleanupEvidence = 'not_issued' | 'finished' | 'unconfirmed';

type CleanupState = 'not_requested' | 'acknowledged' | 'confirmed' | 'unconfirmed';

export class SessionOperationCleanup {
  private deadlineAt?: number;
  private state: CleanupState = 'not_requested';
  private pending?: Promise<boolean>;
  private processStop?: Promise<boolean>;
  private nativeAbort?: Promise<boolean>;

  constructor(
    private readonly session: SessionRequestIdentity,
    private readonly processes: OwnedProcessScope,
    private readonly verifyQuiescence: (
      target: NativeOperationTarget,
      deadlineAt: number
    ) => Promise<boolean>,
    private readonly onConfirmed: () => void
  ) {}

  get cleanupDeadline(): number | undefined {
    return this.deadlineAt;
  }

  get cleanupState(): CleanupState {
    return this.state;
  }

  captureDeadline(deadlineAt = Date.now() + SANDBOX_CONTROL_CLEANUP_TIMEOUT_MS): number {
    this.deadlineAt = Math.min(
      this.deadlineAt ?? Infinity,
      deadlineAt,
      Date.now() + SANDBOX_CONTROL_CLEANUP_TIMEOUT_MS
    );
    return this.deadlineAt;
  }

  stopProcesses(deadlineAt: number): Promise<boolean> {
    const captured = this.captureDeadline(deadlineAt);
    this.processStop ??= this.processes.stop(captured);
    return this.processStop;
  }

  async cleanup(input: {
    deadlineAt: number;
    target?: NativeOperationTarget;
    preClientCleanup?: (deadlineAt: number) => Promise<NativeRetirement>;
    completionEvidence: NativeCleanupEvidence;
    cancel: () => void;
  }): Promise<boolean> {
    if (this.state === 'confirmed') return true;
    const deadlineAt = this.captureDeadline(input.deadlineAt);
    if (this.pending) return this.pending;
    const processes = this.stopProcesses(deadlineAt);
    if (input.completionEvidence === 'unconfirmed') input.cancel();
    this.pending = (async () => {
      if (!(await processes)) return false;
      const target = input.target;
      if (!target) {
        const retired = await input.preClientCleanup?.(deadlineAt);
        if (retired !== undefined) return retired === 'retired' || retired === 'stale';
        return input.completionEvidence !== 'unconfirmed';
      }
      if (input.completionEvidence !== 'unconfirmed') return true;
      const client = target.client;
      if (!client) {
        const retired = await input.preClientCleanup?.(deadlineAt);
        return retired === 'retired' || retired === 'stale';
      }
      if (!(await this.abortNative(target, deadlineAt))) return false;
      const statuses = await withTimeoutAndAbort(
        withKiloRequestDeadline(signal =>
          client.getSessionStatuses(this.session.directory, signal)
        ),
        {
          timeoutMs: Math.max(1, deadlineAt - Date.now()),
          timeoutMessage: 'Kilo cleanup status probe timed out',
          abortMessage: 'Kilo cleanup status probe cancelled',
        }
      );
      const observed = Object.values(statuses);
      if (observed.length === 0 || !observed.every(value => value.type === 'idle')) return false;
      return this.verifyQuiescence(target, deadlineAt);
    })()
      .catch(() => false)
      .then(confirmed => this.confirm(confirmed, deadlineAt));
    return this.pending;
  }

  confirm(confirmed: boolean, deadlineAt: number): boolean {
    if (this.state === 'confirmed') return true;
    const quiescent =
      confirmed && Date.now() < Math.min(deadlineAt, this.deadlineAt ?? Number.POSITIVE_INFINITY);
    this.state = quiescent ? 'confirmed' : 'unconfirmed';
    if (quiescent) this.onConfirmed();
    return quiescent;
  }

  private abortNative(target: NativeOperationTarget, deadlineAt: number): Promise<boolean> {
    if (this.nativeAbort) return this.nativeAbort;
    const client = target.client;
    if (!client) return Promise.resolve(false);
    this.nativeAbort = withTimeoutAndAbort(
      withKiloRequestDeadline(async signal => {
        const accepted = await client.abortSession({
          sessionId: this.session.kiloSessionId,
          directory: this.session.directory,
          signal,
        });
        if (accepted !== true) return false;
        if (this.state !== 'confirmed') this.state = 'acknowledged';
        return true;
      }),
      {
        timeoutMs: Math.max(1, deadlineAt - Date.now()),
        timeoutMessage: 'Kilo cancellation timed out',
        abortMessage: 'Kilo cancellation cancelled',
      }
    ).catch(() => false);
    return this.nativeAbort;
  }
}
