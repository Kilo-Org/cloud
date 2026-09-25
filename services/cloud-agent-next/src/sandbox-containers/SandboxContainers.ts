import { getBillingContext } from '@kilocode/container-usage';
import { withTimeout } from '@kilocode/worker-utils';
import { DurableObject } from 'cloudflare:workers';
import { billingHeartbeatSeconds } from '../container-usage.js';
import {
  CONTAINERS_INTERCEPT_CA_PATH,
  SANDBOX_INTERCEPT_HTTPS_ENABLED,
  SANDBOX_INTERCEPT_HTTPS_ENV,
} from '../shared/container-intercept.js';
import {
  CONTROL_WRAPPER_LOG_PATH,
  CONTROL_WRAPPER_PATH,
} from '../sandbox-control/container-paths.js';
import { DEADLINE_MS } from '../sandbox-control/deadlines.js';
import {
  ContainersBilling,
  ContainersBillingScheduler,
  resolveContainersBillingIdentity,
  unavailableContainersBillingAdmission,
  type ContainersBillingHost,
} from './containers-billing.js';
import type { Env } from '../types.js';

export type ContainerInstanceSize =
  | 'lite'
  | 'standard-1'
  | 'standard-2'
  | 'standard-3'
  | 'standard-4';

export type ContainersState = 'idle' | 'launching' | 'running' | 'stopping';

export type ContainersLaunchInput = {
  allocationRef: string;
  env: Record<string, string>;
  instance: ContainerInstanceSize;
  containment?: boolean;
};

export type ContainersObservation = {
  running: boolean;
  state: ContainersState;
  currentAllocationRef: string | null;
};

export class ContainersAllocationConflictError extends Error {
  readonly code = 'allocation_conflict';

  constructor(allocationRef: string) {
    super(`Container allocation conflict for ${allocationRef}`);
    this.name = 'ContainersAllocationConflictError';
  }
}

type WrapperAttempt = 'not_started' | 'exec_pending';
type WrapperAttemptRead = WrapperAttempt | 'missing' | 'unknown';

type ContainersRecord = {
  state: ContainersState;
  allocationRef: string | null;
  stopOpId: string | null;
  lastSnapshot: { id: string; sourceAllocation: string } | null;
  instance?: ContainerInstanceSize;
  billingConfigured?: true;
  wrapperAttempt?: WrapperAttempt;
};

type DelayedSchedule<T> = {
  taskId: string;
  callback: string;
  payload: T;
  type: 'delayed';
  time: number;
  delayInSeconds: number;
};

const RECORD_KEY = 'containers:record:v1';
const CONTAINER_IMAGE = 'app';

function containedProcessEnv(env: Record<string, string>): Record<string, string> {
  // Bun reads NODE_EXTRA_CA_CERTS only at process start, so the injected CA file must be
  // readable before this exec for the wrapper's own TLS; cert.ts only completes the bundle
  // append and the child env afterwards.
  return {
    ...env,
    [SANDBOX_INTERCEPT_HTTPS_ENV]: SANDBOX_INTERCEPT_HTTPS_ENABLED,
    NODE_EXTRA_CA_CERTS: CONTAINERS_INTERCEPT_CA_PATH,
  };
}

const PROBE_TIMEOUT_MS = 5_000;
const CONTAINER_CALL_TIMEOUT_MS = 5_000;
/** Pause between readiness probes, so repeated pgrep stays sequential and bounded. */
const WRAPPER_READINESS_POLL_MS = 1_000;
const SNAPSHOT_TIMEOUT_MS = 10_000;
const DESTROY_TIMEOUT_MS = 30_000;
const MAX_LOG_BYTES = 1024 * 1024;

class WrapperExecTimeoutError extends Error {
  constructor() {
    super('wrapper exec timed out');
    this.name = 'WrapperExecTimeoutError';
  }
}

/**
 * Settlement of a retained handle's `exitCode`, observed without racing it. A
 * fulfilled value is terminal for that handle; a rejection is fenced.
 */
type ExitState = { kind: 'pending' } | { kind: 'fulfilled' } | { kind: 'rejected'; error: unknown };

function remainingMs(deadlineAt: number): number {
  return Math.max(0, deadlineAt - Date.now());
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const IDLE_RECORD: ContainersRecord = {
  state: 'idle',
  allocationRef: null,
  stopOpId: null,
  lastSnapshot: null,
};

/**
 * A persisted phase is untrusted data: only the two written values are honoured.
 * Absence on `launching` is a legacy record whose exec state is unknown; absence
 * on `idle` is a fresh allocation. The caller's state decides which it is.
 */
function readWrapperAttempt(record: ContainersRecord): WrapperAttemptRead {
  const value = (record as { wrapperAttempt?: unknown }).wrapperAttempt;
  if (value === undefined) return 'missing';
  if (value === 'not_started' || value === 'exec_pending') return value;
  return 'unknown';
}

export class SandboxContainers extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();
  private billing: ContainersBilling | undefined;
  private schedules: ContainersBillingScheduler | undefined;

  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async launchWrapper(input: ContainersLaunchInput): Promise<{ started: boolean }> {
    return this.runExclusive(async () => {
      const ref = input.allocationRef;
      const stored = await this.readRecord();
      if (stored.allocationRef !== null && stored.allocationRef !== ref) {
        throw new ContainersAllocationConflictError(ref);
      }
      if (stored.allocationRef === ref && stored.state === 'stopping') {
        throw new ContainersAllocationConflictError(ref);
      }
      return this.launchEntry(stored, ref, input);
    });
  }

  /**
   * Decide what an entry into `launchWrapper` may physically do from the
   * persisted phase. The phase is the only durable record of whether a previous
   * bun exec may still be in flight, so it gates every write and container call.
   */
  private async launchEntry(
    stored: ContainersRecord,
    ref: string,
    input: ContainersLaunchInput
  ): Promise<{ started: boolean }> {
    const sameRef = stored.allocationRef === ref;
    const phase = readWrapperAttempt(stored);
    if (stored.state === 'running' && sameRef) {
      // A pending (or unknown) phase means a bun exec may still be starting; the
      // running record must not be touched or the fence would be lost.
      if (phase === 'exec_pending' || phase === 'unknown') return { started: false };
      await this.installLaunchInstance(stored, input.instance);
      return { started: false };
    }
    if (stored.state === 'launching' && sameRef) {
      if (phase === 'not_started') {
        const record = await this.installLaunchInstance(stored, input.instance);
        return this.resumePreExecLaunch(
          record,
          ref,
          input.env,
          input.instance,
          input.containment === true
        );
      }
      if (phase === 'exec_pending' || phase === 'missing') {
        return this.adoptUncertainWrapper(
          stored,
          ref,
          input.containment === true,
          phase === 'missing'
        );
      }
      throw new Error('Container wrapper attempt phase is unknown');
    }
    if (stored.state === 'idle' && phase === 'missing') {
      return this.freshLaunch(stored, ref, input);
    }
    throw new Error('Container wrapper attempt phase conflicts with the allocation state');
  }

  private async freshLaunch(
    stored: ContainersRecord,
    ref: string,
    input: ContainersLaunchInput
  ): Promise<{ started: boolean }> {
    const container = this.requiredContainer();
    // Persist the accepted physical instance before any early return or physical
    // operation, so a resumed launch whose exec fails still records its size.
    const record = await this.installLaunchInstance(stored, input.instance);
    if (input.containment) await this.installContainmentProxy(container);
    // Ownership is retained before start: an ambiguous start that takes effect must not release the allocation.
    await this.writeRecord({
      ...record,
      state: 'launching',
      allocationRef: ref,
      stopOpId: null,
      wrapperAttempt: 'not_started',
    });
    await this.startContainerAndActivateBilling(
      container,
      record,
      this.startOptions(input.instance, record.lastSnapshot?.id)
    );
    await this.startWrapper(container, input.env, input.containment === true);
    await this.writeRunning(ref, 'clear');
    return { started: true };
  }

  async observe(_allocationRef: string): Promise<ContainersObservation> {
    const record = await this.readRecord();
    return {
      running: this.ctx.container?.running === true,
      state: record.state,
      currentAllocationRef: record.allocationRef,
    };
  }

  async schedule<T = string>(
    when: Date | number,
    callback: string,
    payload?: T
  ): Promise<DelayedSchedule<T>> {
    const delaySeconds =
      typeof when === 'number' ? when : Math.max(0, (when.getTime() - Date.now()) / 1_000);
    const dueAtMs = await this.billingScheduler().schedule(delaySeconds, callback, payload);
    return {
      taskId: callback,
      callback,
      payload: payload as T,
      type: 'delayed',
      time: dueAtMs,
      delayInSeconds: delaySeconds,
    };
  }

  deleteSchedules(callback: string): void {
    this.billingScheduler().deleteSchedules(callback);
  }

  async getState(): Promise<{ status: 'running' | 'stopped'; lastChange: number }> {
    const status = this.ctx.container?.running === true ? 'running' : 'stopped';
    if (status === 'running') return { status, lastChange: Date.now() };
    // A self-stop carries no exit timestamp, so the boundary is the last delivered
    // running measurement, never the observation time. Settlement cannot bill past the
    // physical stop; the omitted span is up to the last successful measurement, under one
    // heartbeat only at normal cadence and more if a heartbeat is delayed or undelivered.
    const context = await getBillingContext(this.ctx.storage);
    const lastChange =
      context === undefined
        ? Date.now()
        : (context.stoppedObservedAtMs ?? context.usageMeasuredAtMs);
    return { status, lastChange };
  }

  async alarm(): Promise<void> {
    const scheduler = this.billingScheduler();
    // Read due entries without removing them. Each entry stays durable until its
    // dispatch completes, so a failure here leaves the alarm retry able to
    // re-dispatch it with its original generation.
    const due = await scheduler.dueSchedules();
    await this.ensureBillingForPersistedRecord();
    let failure: unknown;
    for (const entry of due) {
      const callback = (
        this as unknown as Record<string, ((payload?: unknown) => Promise<void>) | undefined>
      )[entry.callback];
      if (typeof callback !== 'function') {
        await scheduler.completeDue(entry);
        continue;
      }
      try {
        await callback.call(this, entry.payload);
        await scheduler.completeDue(entry);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  }

  async configureBilling(input: unknown, instance?: ContainerInstanceSize): Promise<void> {
    const prepared = await this.prepareBillingConfiguration(instance);
    if ('refusal' in prepared) {
      throw new Error(`Container billing identity change refused: ${prepared.refusal.message}`);
    }
    const billing = this.billingForRecord(prepared.record);
    if (!billing) return;
    await billing.configureBilling(input);
  }

  async ensureBillingAdmission(input: unknown, instance?: ContainerInstanceSize) {
    const prepared = await this.prepareBillingConfiguration(instance);
    if ('refusal' in prepared) {
      return {
        success: false as const,
        code: 'meter_unavailable' as const,
        message: prepared.refusal.message,
      };
    }
    const billing = this.billingForRecord(prepared.record);
    return billing
      ? billing.ensureBillingAdmission(input)
      : unavailableContainersBillingAdmission(input);
  }

  async isBillingBlocked(): Promise<boolean> {
    const billing = this.billingForRecord(await this.readRecord());
    return billing ? billing.isBillingBlocked() : false;
  }

  async isContainerRunning(): Promise<boolean> {
    return this.ctx.container?.running === true;
  }

  async forceDestroyForControlPlane(): Promise<void> {
    const container = this.ctx.container;
    if (!container || typeof container.destroy !== 'function') {
      throw new Error('Native container destruction is unavailable');
    }
    await container.destroy();
    const record = await this.readRecord();
    await this.writeRecord(this.terminalRecord(record));
    await this.settleBillingAtStop(record);
  }

  async getBillingRuntimeStatus() {
    const billing = this.billingForRecord(await this.readRecord());
    return billing?.getBillingRuntimeStatus();
  }

  async billingForceStop(generation: string): Promise<void> {
    const billing = this.billingForRecord(await this.readRecord());
    await billing?.billingForceStop(generation);
  }

  async stop(allocationRef: string): Promise<'terminal' | 'retryable'> {
    return this.runExclusive(async () => {
      const ref = allocationRef;
      const record = await this.readRecord();
      if (record.allocationRef === null) return 'terminal';
      if (record.allocationRef !== ref && record.state !== 'stopping') return 'terminal';
      if (record.allocationRef !== ref) return 'retryable';
      if (record.state === 'stopping') {
        const stopOpId = record.stopOpId ?? crypto.randomUUID();
        if (record.stopOpId === null) {
          await this.writeRecord({ ...record, stopOpId });
        }
        return this.finishStop(record, ref, stopOpId);
      }
      const stopOpId = crypto.randomUUID();
      const stopping: ContainersRecord = { ...record, state: 'stopping', stopOpId };
      await this.writeRecord(stopping);
      return this.finishStop(stopping, ref, stopOpId);
    });
  }

  async ensureLeaseAtLeast(allocationRef: string, ms: number): Promise<void> {
    const record = await this.readRecord();
    if (record.allocationRef !== allocationRef) return;
    const container = this.ctx.container;
    if (!container) return;
    await withTimeout(
      container.setInactivityTimeout(ms),
      CONTAINER_CALL_TIMEOUT_MS,
      'container lease update timed out'
    );
  }

  async readLog(allocationRef: string, path: string, maxBytes: number): Promise<string> {
    const record = await this.readRecord();
    if (record.allocationRef !== allocationRef) return '';
    if (path !== CONTROL_WRAPPER_LOG_PATH) return '';
    const clamped = Number.isFinite(maxBytes)
      ? Math.min(Math.max(0, Math.floor(maxBytes)), MAX_LOG_BYTES)
      : 0;
    if (clamped === 0) return '';
    const container = this.ctx.container;
    if (!container || container.running !== true) return '';
    try {
      const proc = await withTimeout(
        container.exec(['tail', '-c', String(clamped), path]),
        CONTAINER_CALL_TIMEOUT_MS,
        'container log read timed out'
      );
      const out = await withTimeout(
        proc.output(),
        CONTAINER_CALL_TIMEOUT_MS,
        'container log read timed out'
      );
      return new TextDecoder().decode(out.stdout);
    } catch {
      return '';
    }
  }

  /**
   * Resume a `not_started` launch: the wrapper exec never ran, so it is safe to
   * start the container (when stopped) and probe before deciding. Containment is
   * installed before any start or probe.
   */
  private async resumePreExecLaunch(
    record: ContainersRecord,
    ref: string,
    env: Record<string, string>,
    instance: ContainerInstanceSize,
    containment: boolean
  ): Promise<{ started: boolean }> {
    const container = this.requiredContainer();
    if (containment) await this.installContainmentProxy(container);
    // A stopped container is started and metered before the probe. An already
    // running container is probed first, and billing is activated by outcome.
    if (!container.running) {
      await this.startContainerAndActivateBilling(
        container,
        record,
        this.startOptions(instance, record.lastSnapshot?.id)
      );
    }
    const probe = await this.probeWrapper(container);
    if (probe === 'ambiguous') {
      // A wrapper probe cannot confirm the running container, so activate before
      // signalling the ambiguity rather than leaving it unmetered.
      await this.activateBillingIfRunning(container, record);
      throw new Error('Wrapper probe was ambiguous');
    }
    if (probe === 'absent') {
      // Skip physical start when already running, but still activate billing.
      await this.startContainerAndActivateBilling(
        container,
        record,
        this.startOptions(instance, record.lastSnapshot?.id)
      );
      await this.startWrapper(container, env, containment);
    } else {
      await this.activateBillingIfRunning(container, record);
    }
    await this.writeRunning(ref, 'clear');
    return { started: true };
  }

  /**
   * Adopt a wrapper after a previous `launching` record whose bun exec may still
   * be in flight (pending) or may have started one (legacy). Only a physically
   * running container may be probed, and no start, bun exec or identity change is
   * allowed. A found wrapper keeps the fence; an absent or ambiguous probe is an
   * error, but billing is activated for the stored generation either way.
   */
  private async adoptUncertainWrapper(
    stored: ContainersRecord,
    ref: string,
    containment: boolean,
    stampLegacy: boolean
  ): Promise<{ started: boolean }> {
    const container = this.requiredContainer();
    if (container.running !== true) {
      throw new Error('Container wrapper start is pending and the container is not running');
    }
    if (containment) await this.installContainmentProxy(container);
    const probe = await this.probeWrapper(container);
    await this.activateBillingIfRunning(container, stored);
    if (probe === 'found') {
      // Retain the fence: a different pre-existing exec may still be starting.
      await this.writeRunning(ref, 'retain');
      return { started: true };
    }
    if (stampLegacy) await this.markWrapperAttempt('exec_pending');
    if (probe === 'ambiguous') throw new Error('Wrapper probe was ambiguous');
    throw new Error('Container wrapper start is pending and no wrapper was found');
  }

  /**
   * Classify one wrapper probe. Without a deadline this is the entry probe's
   * fixed 5s + 5s. With a deadline the remaining budget is shared across the
   * pgrep exec and its exitCode, expiry throws `WrapperExecTimeoutError`, and no
   * call begins once no time remains.
   */
  private async probeWrapper(
    container: Container,
    deadlineAt?: number
  ): Promise<'found' | 'absent' | 'ambiguous'> {
    try {
      // Absolute check before the native invocation. Checking only inside
      // awaitProbeCall would be too late: its argument would already have
      // started the pgrep call.
      if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
        throw new WrapperExecTimeoutError();
      }
      const proc = await this.awaitProbeCall(
        container.exec(['pgrep', '-f', CONTROL_WRAPPER_PATH]),
        deadlineAt
      );
      const exitCode = await this.awaitProbeCall(proc.exitCode, deadlineAt);
      if (exitCode === 0) return 'found';
      if (exitCode === 1) return 'absent';
      return 'ambiguous';
    } catch (error) {
      if (error instanceof WrapperExecTimeoutError) throw error;
      return 'ambiguous';
    }
  }

  private async awaitProbeCall<T>(operation: Promise<T>, deadlineAt?: number): Promise<T> {
    if (deadlineAt === undefined) {
      return withTimeout(operation, PROBE_TIMEOUT_MS, 'wrapper probe timed out');
    }
    const remaining = remainingMs(deadlineAt);
    if (remaining <= 0) throw new WrapperExecTimeoutError();
    let expired = false;
    try {
      return await withTimeout(operation, remaining, 'wrapper probe timed out', () => {
        expired = true;
      });
    } catch (error) {
      if (expired) throw new WrapperExecTimeoutError();
      throw error;
    }
  }

  /**
   * Bring the wrapper up on an already-started container.
   *
   * A bun exec can return `pid: 0` before Docker has spawned the process, and it
   * is not cancelled (`withTimeout` only races). The retained handle is observed
   * until it settles or the readiness deadline. While its `exitCode` is pending,
   * the wrapper is probed repeatedly, one sequential probe at a time, so a
   * wrapper that appears late is adopted; a found probe returns success even
   * though the wrapper's own `exitCode` is still pending. No second bun runs
   * during that period. The phase write is awaited, never raced, and rechecked
   * before any native call: if a stalled write returns after the deadline, no
   * exec starts and the phase rolls back to `not_started`.
   */
  private async startWrapper(
    container: Container,
    env: Record<string, string>,
    containment: boolean
  ): Promise<void> {
    const deadlineAt = Date.now() + DEADLINE_MS.wrapperReadiness;
    for (;;) {
      if (Date.now() >= deadlineAt) throw new WrapperExecTimeoutError();
      // Persist the fence before each bun exec. Durable writes are awaited, not
      // raced, so a stalled write may settle the call past the deadline.
      await this.markWrapperAttempt('exec_pending');
      if (Date.now() >= deadlineAt) {
        await this.rollbackToNotStarted();
        throw new WrapperExecTimeoutError();
      }
      const handle = await this.awaitWrapperExec(container, env, containment, deadlineAt);
      if (handle.pid > 0) return;

      // `pid: 0` means Docker has not spawned the process yet. Probe repeatedly
      // while this handle's exitCode is still pending; do not retry the bun. The
      // retained handle's exitCode takes precedence over a probe result: a
      // rejection fails the launch, and a fulfilment forces a fresh reading.
      const exit = this.trackExit(handle.exitCode);
      let retaken = false;
      for (;;) {
        const probe = await this.probeWrapper(container, deadlineAt);
        const exitState = exit();
        if (exitState.kind === 'rejected') throw exitState.error;
        if (exitState.kind === 'fulfilled') {
          if (!retaken) {
            // The handle completed while that probe was in flight; the reading
            // may predate completion, so take a fresh one before deciding.
            retaken = true;
            continue;
          }
          if (probe === 'found') return;
          // An ambiguous reading cannot rule out an existing wrapper, so fail
          // closed instead of retrying the bun.
          if (probe === 'ambiguous') throw new WrapperExecTimeoutError();
          await this.markWrapperAttempt('not_started');
          if (Date.now() >= deadlineAt) throw new WrapperExecTimeoutError();
          break;
        }
        if (probe === 'found') return;
        await this.sleepWithinDeadline(deadlineAt);
      }
    }
  }

  /**
   * Race one native call against the shared deadline. A timeout is a fence, not
   * a cancellation: the native call may still be pending, so the caller must not
   * issue another call.
   */
  private async awaitContainerCall<T>(operation: Promise<T>, deadlineAt: number): Promise<T> {
    let expired = false;
    try {
      return await withTimeout(
        operation,
        remainingMs(deadlineAt),
        'container call timed out',
        () => {
          expired = true;
        }
      );
    } catch (error) {
      if (expired) throw new WrapperExecTimeoutError();
      throw error;
    }
  }

  private async awaitWrapperExec(
    container: Container,
    env: Record<string, string>,
    containment: boolean,
    deadlineAt: number
  ): Promise<ExecProcess> {
    // Absolute check at the native invocation boundary: no exec may begin at or
    // after expiry.
    if (Date.now() >= deadlineAt) throw new WrapperExecTimeoutError();
    return this.awaitContainerCall(
      container.exec(['bun', 'run', CONTROL_WRAPPER_PATH], {
        env: containment ? containedProcessEnv(env) : env,
        cwd: '/',
      }),
      deadlineAt
    );
  }

  private trackExit(exitCode: Promise<number>): () => ExitState {
    let state: ExitState = { kind: 'pending' };
    void exitCode.then(
      () => {
        state = { kind: 'fulfilled' };
      },
      error => {
        state = { kind: 'rejected', error };
      }
    );
    return () => state;
  }

  private async sleepWithinDeadline(deadlineAt: number): Promise<void> {
    const remaining = remainingMs(deadlineAt);
    if (remaining <= 0) return;
    await delay(Math.min(WRAPPER_READINESS_POLL_MS, remaining));
  }

  /**
   * Best-effort rollback after a stalled phase write returned past the deadline.
   * If the rollback write fails, the durable `exec_pending` fence is retained.
   */
  private async rollbackToNotStarted(): Promise<void> {
    try {
      await this.markWrapperAttempt('not_started');
    } catch {
      // Keep the durable fence; a later same-ref launch must not start a new bun.
    }
  }

  private async installContainmentProxy(container: Container): Promise<void> {
    const outbound = this.ctx.exports.ContainersOutbound;
    const worker = outbound({ props: { containerId: this.ctx.id.toString() } });
    await container.interceptOutboundHttps('*', worker);
    await container.interceptAllOutboundHttp(worker);
  }

  private requiredContainer(): Container {
    const container = this.ctx.container;
    if (!container) throw new Error('Container is unavailable');
    return container;
  }

  private startOptions(
    instance: ContainerInstanceSize,
    snapshotId?: string
  ): ContainerStartupOptions {
    // The runtime startup union requires image XOR containerSnapshot.
    if (snapshotId !== undefined) {
      return { containerSnapshot: { id: snapshotId }, instance, enableInternet: true };
    }
    return { image: this.containerImage(), instance, enableInternet: true };
  }

  private containerImage(): string {
    const image = this.requiredContainer().images[CONTAINER_IMAGE];
    if (image === undefined) {
      throw new Error(`Container image "${CONTAINER_IMAGE}" is unavailable`);
    }
    return image;
  }

  private terminalRecord(record: ContainersRecord): ContainersRecord {
    return {
      state: 'idle',
      allocationRef: null,
      stopOpId: null,
      lastSnapshot: record.lastSnapshot,
      ...(record.instance !== undefined ? { instance: record.instance } : {}),
      ...(record.billingConfigured ? { billingConfigured: true } : {}),
    };
  }

  private async finishStop(
    record: ContainersRecord,
    ref: string,
    stopOpId: string
  ): Promise<'terminal' | 'retryable'> {
    const container = this.ctx.container;
    if (!container) {
      // A missing container only proves cleanup for a record that never reached
      // a bun exec. Pending or unclassified phases stay stopping so a later stop
      // can observe the destroy resolve; destroying nothing must not clear them.
      if (readWrapperAttempt(record) !== 'not_started') return 'retryable';
      await this.writeRecord(this.terminalRecord(record));
      await this.settleBillingAtStop(record);
      return 'terminal';
    }
    await this.snapshotBeforeDestroy(container, ref, stopOpId);
    try {
      await withTimeout(container.destroy(), DESTROY_TIMEOUT_MS, 'container destroy timed out');
    } catch {
      // A timed-out destroy has no late callback; the phase is cleared only by a
      // later stop that observes the destroy resolve.
      return 'retryable';
    }
    const current = await this.readRecord();
    await this.writeRecord(this.terminalRecord(current));
    await this.settleBillingAtStop(current);
    return 'terminal';
  }

  private async snapshotBeforeDestroy(
    container: Container,
    ref: string,
    stopOpId: string
  ): Promise<void> {
    const attempt = container.snapshotContainer({});
    try {
      const snapshot = await withTimeout(
        attempt,
        SNAPSHOT_TIMEOUT_MS,
        'container snapshot timed out'
      );
      await this.publishSnapshot(snapshot.id, ref, stopOpId);
    } catch {
      void attempt.then(
        snapshot => this.runExclusive(() => this.publishSnapshot(snapshot.id, ref, stopOpId)),
        () => undefined
      );
    }
  }

  private async publishSnapshot(id: string, ref: string, stopOpId: string): Promise<void> {
    const record = await this.readRecord();
    if (record.state !== 'stopping') return;
    if (record.allocationRef !== ref) return;
    if (record.stopOpId !== stopOpId) return;
    await this.writeRecord({ ...record, lastSnapshot: { id, sourceAllocation: ref } });
  }

  private billingScheduler(): ContainersBillingScheduler {
    if (this.schedules === undefined) {
      this.schedules = new ContainersBillingScheduler({
        storage: this.ctx.storage,
        setAlarm: scheduledTime => this.ctx.storage.setAlarm(scheduledTime),
        deleteAlarm: () => this.ctx.storage.deleteAlarm(),
        waitUntil: promise => this.ctx.waitUntil(promise),
      });
    }
    return this.schedules;
  }

  private billingForRecord(record: ContainersRecord): ContainersBilling | undefined {
    if (record.billingConfigured !== true) return undefined;
    const identity = resolveContainersBillingIdentity(record.instance);
    if (!identity) return undefined;
    if (this.billing?.identity.className !== identity.className) {
      this.billing = new ContainersBilling(identity, this.billingHost());
    }
    return this.billing;
  }

  private async ensureBillingForPersistedRecord(): Promise<ContainersBilling | undefined> {
    return this.billingForRecord(await this.readRecord());
  }

  /**
   * An identity change waits for the old generation to settle through its old
   * persisted identity; otherwise it could settle through the new service.
   */
  private async installLaunchInstance(
    record: ContainersRecord,
    instance: ContainerInstanceSize
  ): Promise<ContainersRecord> {
    if (record.instance === instance) return record;
    if (record.instance !== undefined && record.billingConfigured === true) {
      const settlement = await this.prepareIdentityReplacement(record);
      if (!settlement.ok) throw new Error(settlement.message);
    }
    const updated: ContainersRecord = { ...record, instance };
    // Launch never introduces billing attribution (admission owns that); it only
    // clears a flag the new size can no longer honour.
    if (resolveContainersBillingIdentity(instance) === undefined) {
      delete updated.billingConfigured;
    }
    await this.writeRecord(updated);
    return updated;
  }

  /**
   * Gate an identity change on the old generation being settled. Never awaits
   * settlement on the DO operation queue: an unsettled, physically stopped
   * generation is settled as a shadow task through its old persisted identity,
   * and the caller gets a recoverable refusal until that settlement lands. A
   * physically running generation is refused without starting settlement, so
   * the persisted identity is unchanged in both cases.
   */
  private async prepareIdentityReplacement(
    record: ContainersRecord
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const billing = this.billingForRecord(record);
    if (!billing || !(await billing.hasUnsettledGeneration())) return { ok: true };
    if (this.ctx.container?.running === true) {
      return {
        ok: false,
        message: 'Container billing admission is waiting for the previous run to stop',
      };
    }
    try {
      await billing.initiateSettlement();
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Final usage settlement is unavailable',
      };
    }
    return {
      ok: false,
      message: 'Container billing is settling the previous run; retry the request',
    };
  }

  private prepareBillingConfiguration(
    instance: ContainerInstanceSize | undefined
  ): Promise<{ record: ContainersRecord } | { refusal: { message: string } }> {
    return this.runExclusive(async () => {
      const record = await this.readRecord();
      const resolved = instance ?? record.instance;
      if (resolved === undefined) return { record };
      if (
        record.instance !== undefined &&
        record.instance !== resolved &&
        record.billingConfigured === true
      ) {
        const settlement = await this.prepareIdentityReplacement(record);
        if (!settlement.ok) return { refusal: { message: settlement.message } };
      }
      const billingConfigured = resolveContainersBillingIdentity(resolved) !== undefined;
      if (
        record.instance === resolved &&
        (record.billingConfigured === true) === billingConfigured
      ) {
        return { record };
      }
      const updated: ContainersRecord = { ...record, instance: resolved };
      if (billingConfigured) {
        updated.billingConfigured = true;
      } else {
        delete updated.billingConfigured;
      }
      await this.writeRecord(updated);
      return { record: updated };
    });
  }

  private async activateBilling(record: ContainersRecord): Promise<void> {
    const billing = this.billingForRecord(record);
    if (!billing) return;
    await billing.onContainerStarted();
  }

  /**
   * The single owner of "a physically running container is billable": activate
   * metering whenever the runtime reports the container as running, whichever
   * start or adoption path reached this point.
   */
  private async activateBillingIfRunning(
    container: Container,
    record: ContainersRecord
  ): Promise<void> {
    if (container.running) await this.activateBilling(record);
  }

  /**
   * Start the container if it is not already running, then activate metering for
   * a physically running container. A start that throws after taking effect
   * still activates before the error propagates.
   */
  private async startContainerAndActivateBilling(
    container: Container,
    record: ContainersRecord,
    options: ContainerStartupOptions
  ): Promise<void> {
    if (!container.running) {
      try {
        container.start(options);
      } catch (error) {
        await this.activateBillingIfRunning(container, record);
        throw error;
      }
    }
    await this.activateBillingIfRunning(container, record);
  }

  private async settleBillingAtStop(record: ContainersRecord): Promise<void> {
    const billing = this.billingForRecord(record);
    if (!billing) return;
    await billing.onContainerStopped({ reason: 'runtime_signal' });
  }

  private async stopBillingContainer(): Promise<void> {
    const record = await this.readRecord();
    if (record.allocationRef === null) return;
    await this.stop(record.allocationRef);
  }

  private async destroyBillingContainer(): Promise<void> {
    const record = await this.readRecord();
    if (record.allocationRef === null) return;
    if ((await this.stop(record.allocationRef)) === 'retryable') {
      throw new Error('Container force-destroy remained retryable');
    }
  }

  private billingHost(): ContainersBillingHost {
    return {
      container: this,
      storage: this.ctx.storage,
      meter: this.env.CONTAINER_USAGE_METER,
      heartbeatSeconds: billingHeartbeatSeconds(this.env.CONTAINER_BILLING_HEARTBEAT_SECONDS),
      isContainerRunning: () => this.ctx.container?.running === true,
      stopContainer: () => this.stopBillingContainer(),
      destroyContainer: () => this.destroyBillingContainer(),
      durableObjectId: this.ctx.id.toString(),
      waitUntil: promise => this.ctx.waitUntil(promise),
    };
  }

  private async readRecord(): Promise<ContainersRecord> {
    return (await this.ctx.storage.get<ContainersRecord>(RECORD_KEY)) ?? IDLE_RECORD;
  }

  private async writeRecord(record: ContainersRecord): Promise<void> {
    await this.ctx.storage.put(RECORD_KEY, record);
  }

  private async markWrapperAttempt(wrapperAttempt: WrapperAttempt): Promise<void> {
    const latest = await this.readRecord();
    await this.writeRecord({ ...latest, wrapperAttempt });
  }

  /**
   * Sole running-record writer. It reads the latest record so a phase written
   * mid-call is not erased by a stale pre-start copy: `clear` completes a
   * same-call success, `retain` keeps the pending fence after adopting a wrapper.
   */
  private async writeRunning(ref: string, phase: 'clear' | 'retain'): Promise<void> {
    const latest = await this.readRecord();
    const next: ContainersRecord = {
      ...latest,
      state: 'running',
      allocationRef: ref,
      stopOpId: null,
    };
    if (phase === 'retain') {
      next.wrapperAttempt = 'exec_pending';
    } else {
      delete next.wrapperAttempt;
    }
    await this.writeRecord(next);
  }
}
