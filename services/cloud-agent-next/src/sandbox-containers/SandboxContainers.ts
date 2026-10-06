import { getBillingContext } from '@kilocode/container-usage';
import { withTimeout } from '@kilocode/worker-utils';
import { DurableObject } from 'cloudflare:workers';
import { billingHeartbeatSeconds } from '../container-usage.js';
import { resolveControlPlaneTimers } from '../shared/control-plane-timers.js';
import { logger } from '../logger.js';
import {
  CONTAINERS_INTERCEPT_CA_PATH,
  SANDBOX_INTERCEPT_HTTPS_ENABLED,
  SANDBOX_INTERCEPT_HTTPS_ENV,
} from '../shared/container-intercept.js';
import {
  CONTROL_PROCESS_MATCH,
  CONTROL_SUPERVISOR_PATH,
  CONTROL_WRAPPER_LOG_PATH,
} from '../sandbox-control/container-paths.js';
import { CONTROL_PLANE_NATIVE_LOGS_ENV } from '../shared/control-diagnostics.js';
import { DEADLINE_MS } from '../sandbox-control/deadlines.js';
import { diagnosticCause, logControlDiagnostic } from '../sandbox-control/diagnostics.js';
import {
  ContainersBilling,
  ContainersBillingScheduler,
  resolveContainersBillingIdentity,
  unavailableContainersBillingAdmission,
  type ContainersBillingHost,
} from './containers-billing.js';
import {
  createRepoSnapshotIndex,
  repoSnapshotIndexKey,
  type RepoSnapshotIndex,
} from './repo-snapshot-index.js';
import type { Env } from '../types.js';

export type ContainerInstanceSize =
  | 'lite'
  | 'standard-1'
  | 'standard-2'
  | 'standard-3'
  | 'standard-4';

export type ContainersState = 'idle' | 'launching' | 'running' | 'stopping';

/** What a physical start used: the image, or a repository snapshot of it. */
export type ContainersStartSource = 'image' | 'repository';

export type ContainersLaunchInput = {
  allocationRef: string;
  env: Record<string, string>;
  instance: ContainerInstanceSize;
  containment?: boolean;
  /** Keyed hash of the launch's scope, repository and env; absent means no snapshot. */
  repoKey?: string;
  /** Start from the image and forget the snapshot stored for `repoKey`. */
  discardRepository?: true;
};

export type ContainersLaunchResult = {
  started: boolean;
  startSource: ContainersStartSource;
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
  // Legacy per-allocation snapshots are retained but never restored or consumed.
  lastSnapshot: { id: string; sourceAllocation: string } | null;
  /** How this allocation's container was started; absent on a record that predates it. */
  startSource?: ContainersStartSource;
  instance?: ContainerInstanceSize;
  billingConfigured?: true;
  wrapperAttempt?: WrapperAttempt;
};

type ResolvedStart = {
  source: ContainersStartSource;
  options: ContainerStartupOptions;
  /** Set only for a repository start, so a failed one can forget its entry. */
  indexKey: string | null;
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

const MAIN_PROCESS_SLEEP_CMDLINE = new TextEncoder().encode('sleep\0infinity');
const MAIN_PROCESS_SUPERVISOR_CMDLINE = new TextEncoder().encode(
  `/bin/sh\0${CONTROL_SUPERVISOR_PATH}`
);

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

type MainProcessIdentity = 'sleep' | 'supervisor' | 'ambiguous';

/**
 * Classify PID 1 from its `/proc/1/cmdline` bytes. The two known main processes
 * are the image default `sleep infinity` and the native supervisor entrypoint;
 * a trailing NUL is tolerated. Timeout, non-zero, empty, and anything else is
 * ambiguous and must fail the launch rather than guess.
 */
function classifyMainProcess(cmdline: Uint8Array): MainProcessIdentity {
  const trimmed =
    cmdline.byteLength > 0 && cmdline[cmdline.byteLength - 1] === 0
      ? cmdline.subarray(0, cmdline.byteLength - 1)
      : cmdline;
  if (bytesEqual(trimmed, MAIN_PROCESS_SLEEP_CMDLINE)) return 'sleep';
  if (bytesEqual(trimmed, MAIN_PROCESS_SUPERVISOR_CMDLINE)) return 'supervisor';
  return 'ambiguous';
}

const PROBE_TIMEOUT_MS = 5_000;
const CONTAINER_CALL_TIMEOUT_MS = 5_000;
/** Pause between readiness probes, so repeated pgrep stays sequential and bounded. */
const WRAPPER_READINESS_POLL_MS = 1_000;
/** Bounds one repository capture. The wrapper's own wait is a backstop over this. */
const REPO_CAPTURE_TIMEOUT_MS = 5 * 60_000;
const DESTROY_TIMEOUT_MS = 30_000;

type RepositoryCaptureOutcome = 'stored' | 'index_unavailable' | 'abandoned' | 'failed';

/**
 * One line per capture, with how long the platform snapshot took, so the capture
 * bound can be tuned from real durations. It carries no key, id or credential.
 */
function logRepositoryCapture(
  outcome: RepositoryCaptureOutcome,
  durationMs: number,
  error?: unknown
): void {
  const fields = logger.withFields({
    outcome,
    durationMs,
    ...(error === undefined ? {} : { error: error instanceof Error ? error.message : 'unknown' }),
  });
  if (outcome === 'stored') fields.info('Repository snapshot captured');
  else fields.warn('Repository snapshot not saved');
}
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

/** A record that predates `startSource` was started from the image. */
function recordedStartSource(record: ContainersRecord): ContainersStartSource {
  return record.startSource ?? 'image';
}

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

/** Name the branch that decided a stop: every 'retryable' used to look the same in the logs. */
function stopPath(
  path: string,
  result: 'terminal' | 'retryable',
  fields: Record<string, string | number | boolean | undefined> = {}
): 'terminal' | 'retryable' {
  logControlDiagnostic(
    'container_stop',
    { path, result, ...fields },
    result === 'retryable' ? 'warn' : 'info'
  );
  return result;
}

export class SandboxContainers extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();
  private billing: ContainersBilling | undefined;
  private schedules: ContainersBillingScheduler | undefined;
  private repoSnapshots: RepoSnapshotIndex | null | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = this.ctx.container;
    if (container?.running) {
      void this.ctx.blockConcurrencyWhile(() =>
        container.setInactivityTimeout(
          resolveControlPlaneTimers(this.env as { CONTROL_PLANE_TIMER_DIVISOR?: string }).sandbox
            .providerLeaseMs
        )
      );
    }
  }

  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async launchWrapper(input: ContainersLaunchInput): Promise<ContainersLaunchResult> {
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
  ): Promise<ContainersLaunchResult> {
    const sameRef = stored.allocationRef === ref;
    const phase = readWrapperAttempt(stored);
    if (stored.state === 'running' && sameRef) {
      // A pending (or unknown) phase means a bun exec may still be starting; the
      // running record must not be touched or the fence would be lost.
      if (phase === 'exec_pending' || phase === 'unknown') {
        return { started: false, startSource: recordedStartSource(stored) };
      }
      await this.installLaunchInstance(stored, input.instance);
      return { started: false, startSource: recordedStartSource(stored) };
    }
    if (stored.state === 'launching' && sameRef) {
      if (phase === 'not_started') {
        const record = await this.installLaunchInstance(stored, input.instance);
        return this.resumePreExecLaunch(record, ref, input);
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
  ): Promise<ContainersLaunchResult> {
    const container = this.requiredContainer();
    const containment = input.containment === true;
    // Persist the accepted physical instance before any early return or physical
    // operation, so a resumed launch whose exec fails still records its size.
    const record = await this.installLaunchInstance(stored, input.instance);
    if (containment) await this.installContainmentProxy(container);
    const start = await this.resolveStart(input, true);
    return this.issueNativeSupervisor(record, ref, start);
  }

  /**
   * Issue the native supervisor as PID 1: fence, start, confirm identity, mark
   * running. Containment is installed by the caller, which owns its ordering
   * before any physical call.
   */
  private async issueNativeSupervisor(
    record: ContainersRecord,
    ref: string,
    start: ResolvedStart
  ): Promise<ContainersLaunchResult> {
    const container = this.requiredContainer();
    // Ownership is retained before start: an ambiguous start that takes effect
    // must not release the allocation. Never leave `not_started` across the start.
    await this.writeRecord({
      ...record,
      state: 'launching',
      allocationRef: ref,
      stopOpId: null,
      wrapperAttempt: 'exec_pending',
      startSource: start.source,
    });
    await this.runStart(start, async () => {
      await this.startContainerAndActivateBilling(container, record, start.options);
      await this.awaitSupervisorMainProcess(container);
    });
    await this.writeRunning(ref, 'clear');
    return { started: true, startSource: start.source };
  }

  /**
   * The one start-source rule: a physical start uses the repository snapshot for
   * the launch's `repoKey` and this image when the index has one, and the image
   * otherwise. `discard` forgets the stored entry first, so a start that follows a
   * failed repository start cannot use it again.
   *
   * Emits one `snapshot_lookup` diagnostic per start so `image` vs `repository`
   * and the reason (no key, no index, miss, discarded, not allowed) are visible.
   * Like the capture line it carries no repository key; the key is logged by the
   * Sandbox DO, which owns it.
   */
  private async resolveStart(
    input: ContainersLaunchInput,
    allowRepository: boolean
  ): Promise<ResolvedStart> {
    const imageStart: ResolvedStart = {
      source: 'image',
      options: this.startOptions(
        input.instance,
        this.nativeLaunchEnv(input.env, input.containment === true)
      ),
      indexKey: null,
    };
    const index = this.repoSnapshotIndex();
    if (index === null) {
      this.logSnapshotLookup(input.allocationRef, 'image', 'index_unavailable');
      return imageStart;
    }
    if (input.repoKey === undefined) {
      this.logSnapshotLookup(input.allocationRef, 'image', 'no_repo_key');
      return imageStart;
    }
    const indexKey = await repoSnapshotIndexKey(input.repoKey, this.containerImage());
    if (input.discardRepository === true) {
      await index.remove(indexKey);
      this.logSnapshotLookup(input.allocationRef, 'image', 'discarded');
      return imageStart;
    }
    if (!allowRepository) {
      this.logSnapshotLookup(input.allocationRef, 'image', 'not_allowed');
      return imageStart;
    }
    const entry = await index.lookup(indexKey);
    if (entry === null) {
      this.logSnapshotLookup(input.allocationRef, 'image', 'index_miss');
      return imageStart;
    }
    this.logSnapshotLookup(input.allocationRef, 'repository', 'index_hit');
    return {
      source: 'repository',
      options: this.startOptions(
        input.instance,
        this.nativeLaunchEnv(input.env, input.containment === true),
        entry.snapshotId
      ),
      indexKey,
    };
  }

  private sandboxNameForLog(): string {
    return this.ctx.id.name ?? this.ctx.id.toString();
  }

  private logSnapshotLookup(
    allocationRef: string,
    source: ContainersStartSource,
    reason: string
  ): void {
    logControlDiagnostic('snapshot_lookup', {
      sandboxId: this.sandboxNameForLog(),
      allocationRef,
      source,
      reason,
    });
  }

  /**
   * Run a start and forget the repository snapshot it used when it fails, so a
   * broken snapshot costs one attempt and the next start is from the image.
   */
  private async runStart(start: ResolvedStart, attempt: () => Promise<void>): Promise<void> {
    try {
      await attempt();
    } catch (error) {
      if (start.source === 'repository' && start.indexKey !== null) {
        await this.repoSnapshotIndex()?.remove(start.indexKey);
        logControlDiagnostic('snapshot_discard', {
          sandboxId: this.sandboxNameForLog(),
          reason: 'repository_start_failed',
        });
      }
      throw error;
    }
  }

  private repoSnapshotIndex(): RepoSnapshotIndex | null {
    if (this.repoSnapshots === undefined) {
      this.repoSnapshots = createRepoSnapshotIndex(this.env.REPO_SNAPSHOTS);
    }
    return this.repoSnapshots;
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
      if (record.allocationRef === null) return stopPath('no_allocation', 'terminal');
      if (record.allocationRef !== ref && record.state !== 'stopping') {
        return stopPath('other_allocation', 'terminal');
      }
      if (record.allocationRef !== ref) return stopPath('other_allocation_stopping', 'retryable');
      if (record.state === 'stopping') {
        const stopOpId = record.stopOpId ?? crypto.randomUUID();
        if (record.stopOpId === null) {
          await this.writeRecord({ ...record, stopOpId });
        }
        return this.finishStop(record);
      }
      const stopOpId = crypto.randomUUID();
      const stopping: ContainersRecord = { ...record, state: 'stopping', stopOpId };
      await this.writeRecord(stopping);
      return this.finishStop(stopping);
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
   * Resume a `not_started` launch: the main process was never issued. A stopped
   * container gets the native supervisor entrypoint; a running container is
   * settled by PID 1 first — a verified supervisor completes issuance, the image
   * default `sleep infinity` keeps the existing exec and broad probe.
   */
  private async resumePreExecLaunch(
    record: ContainersRecord,
    ref: string,
    input: ContainersLaunchInput
  ): Promise<ContainersLaunchResult> {
    const container = this.requiredContainer();
    const containment = input.containment === true;
    if (containment) await this.installContainmentProxy(container);
    if (!container.running) {
      const start = await this.resolveStart(input, record.startSource === 'repository');
      return this.issueNativeSupervisor(record, ref, start);
    }
    if ((await this.settleRunningMainProcess(record, ref)) === 'supervisor') {
      return { started: true, startSource: recordedStartSource(record) };
    }
    // The image default `sleep infinity` still owns the container; the wrapper
    // exec is the thing being resumed. The broad probe and the exec retry stay.
    const probe = await this.probeWrapper(container);
    if (probe === 'ambiguous') {
      await this.activateBillingIfRunning(container, record);
      throw new Error('Wrapper probe was ambiguous');
    }
    if (probe === 'absent') {
      // Meter the stored generation, then refuse to exec if the container stopped
      // while the probe was in flight. Starting here would issue a native
      // supervisor on a stopped container and race a second supervisor exec.
      await this.activateBillingIfRunning(container, record);
      if (container.running !== true) {
        throw new Error('Container stopped before the wrapper exec');
      }
      await this.startWrapper(container, input.env, containment);
    } else {
      await this.activateBillingIfRunning(container, record);
    }
    await this.writeRunning(ref, 'clear');
    return { started: true, startSource: recordedStartSource(record) };
  }

  /**
   * Settle the PID 1 identity of an already-running container. A verified
   * supervisor completes issuance (billing + running); an ambiguous identity
   * meters the stored generation and throws. The image default `sleep infinity`
   * returns to the caller, which owns the sleep-path probe/exec.
   */
  private async settleRunningMainProcess(
    record: ContainersRecord,
    ref: string
  ): Promise<'supervisor' | 'sleep'> {
    const container = this.requiredContainer();
    const identity = await this.readMainProcessIdentity(container);
    if (identity === 'ambiguous') {
      await this.activateBillingIfRunning(container, record);
      throw new Error('Main process identity is ambiguous');
    }
    if (identity === 'supervisor') {
      await this.activateBillingIfRunning(container, record);
      await this.writeRunning(ref, 'clear');
      return 'supervisor';
    }
    return 'sleep';
  }

  /**
   * Adopt a wrapper after a previous `launching` record whose bun exec may still
   * be in flight (pending) or may have started one (legacy). Only a physically
   * running container may be probed, and no start, bun exec or identity change is
   * allowed. A verified supervisor PID 1 already completed issuance; the image
   * default `sleep infinity` keeps the existing broad probe. An absent or
   * ambiguous probe is an error, but billing is activated for the stored
   * generation either way.
   */
  private async adoptUncertainWrapper(
    stored: ContainersRecord,
    ref: string,
    containment: boolean,
    stampLegacy: boolean
  ): Promise<ContainersLaunchResult> {
    const container = this.requiredContainer();
    if (container.running !== true) {
      throw new Error('Container wrapper start is pending and the container is not running');
    }
    if (containment) await this.installContainmentProxy(container);
    if ((await this.settleRunningMainProcess(stored, ref)) === 'supervisor') {
      return { started: true, startSource: recordedStartSource(stored) };
    }
    const probe = await this.probeWrapper(container);
    await this.activateBillingIfRunning(container, stored);
    if (probe === 'found') {
      // Retain the fence: a different pre-existing exec may still be starting.
      await this.writeRunning(ref, 'retain');
      return { started: true, startSource: recordedStartSource(stored) };
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
        container.exec(['pgrep', '-f', CONTROL_PROCESS_MATCH]),
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
          await this.sleepWithinDeadline(deadlineAt);
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
      container.exec(['/bin/sh', CONTROL_SUPERVISOR_PATH], {
        env: this.nativeLaunchEnv(env, containment),
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
    env: Record<string, string>,
    snapshotId?: string
  ): ContainerStartupOptions {
    // Native issuance: the main process is the supervisor, not the image default
    // `sleep infinity`. The supervisor script is already in the image.
    return {
      ...(snapshotId === undefined
        ? { image: this.containerImage() }
        : { containerSnapshot: { id: snapshotId } }),
      instance,
      enableInternet: true,
      entrypoint: ['/bin/sh', CONTROL_SUPERVISOR_PATH],
      env,
    };
  }

  /**
   * The env for a native start and for a sleep-main-process exec. Containment CA
   * goes on both; the stderr gate is native-only and set here, never in the
   * shared launch-env builder.
   */
  private nativeLaunchEnv(
    env: Record<string, string>,
    containment: boolean
  ): Record<string, string> {
    return {
      ...(containment ? containedProcessEnv(env) : env),
      [CONTROL_PLANE_NATIVE_LOGS_ENV]: '1',
    };
  }

  private async readMainProcessIdentity(container: Container): Promise<MainProcessIdentity> {
    return this.readMainProcessIdentityWithin(container, Date.now() + PROBE_TIMEOUT_MS);
  }

  private async readMainProcessIdentityWithin(
    container: Container,
    deadlineAt: number
  ): Promise<MainProcessIdentity> {
    try {
      const proc = await this.awaitContainerCall(
        container.exec(['cat', '/proc/1/cmdline']),
        deadlineAt
      );
      const output = await this.awaitContainerCall(proc.output(), deadlineAt);
      if (output.exitCode !== 0) return 'ambiguous';
      return classifyMainProcess(new Uint8Array(output.stdout));
    } catch {
      return 'ambiguous';
    }
  }

  /**
   * Confirm the native start issued the supervisor as PID 1, bounded by the
   * existing wrapper readiness deadline. This is identity, not a wrapper-child
   * poll: a deadline without a match, or a container that stops first, throws
   * and does not exec.
   */
  private async awaitSupervisorMainProcess(container: Container): Promise<void> {
    const deadlineAt = Date.now() + DEADLINE_MS.wrapperReadiness;
    for (;;) {
      if (container.running !== true) {
        throw new Error('Container stopped before the supervisor main process was confirmed');
      }
      const identity = await this.readMainProcessIdentityWithin(container, deadlineAt);
      if (identity === 'supervisor') return;
      if (Date.now() >= deadlineAt) throw new WrapperExecTimeoutError();
      await this.sleepWithinDeadline(deadlineAt);
    }
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
      lastSnapshot: record.lastSnapshot ?? null,
      ...(record.instance !== undefined ? { instance: record.instance } : {}),
      ...(record.billingConfigured ? { billingConfigured: true } : {}),
    };
  }

  private async finishStop(record: ContainersRecord): Promise<'terminal' | 'retryable'> {
    const container = this.ctx.container;
    if (!container) {
      // A missing container only proves cleanup for a record that never reached
      // a bun exec. Pending or unclassified phases stay stopping so a later stop
      // can observe the destroy resolve; destroying nothing must not clear them.
      if (readWrapperAttempt(record) !== 'not_started') {
        return stopPath('no_container_unfenced', 'retryable', {
          wrapperAttempt: readWrapperAttempt(record),
        });
      }
      await this.writeRecord(this.terminalRecord(record));
      await this.settleBillingAtStop(record);
      return stopPath('no_container_not_started', 'terminal');
    }
    const destroyStartedAt = Date.now();
    try {
      await withTimeout(container.destroy(), DESTROY_TIMEOUT_MS, 'container destroy timed out');
    } catch (error) {
      // A timed-out destroy has no late callback; the phase is cleared only by a
      // later stop that observes the destroy resolve.
      return stopPath('destroy_failed', 'retryable', {
        destroyMs: Date.now() - destroyStartedAt,
        running: container.running,
        errorName: error instanceof Error ? diagnosticCause(error.name) : 'unknown',
        cause: error instanceof Error ? diagnosticCause(error.message) : 'unknown',
      });
    }
    const current = await this.readRecord();
    await this.writeRecord(this.terminalRecord(current));
    await this.settleBillingAtStop(current);
    return stopPath('destroyed', 'terminal', { destroyMs: Date.now() - destroyStartedAt });
  }

  /**
   * Snapshot the running container's root filesystem as the repository snapshot
   * for `repoKey` and this image. It does not take the operation queue: a capture
   * of unknown duration must not delay a stop or a launch. The snapshot is
   * published only while `allocationRef` is still the running allocation, and
   * any failure is a `false` the caller may ignore; a capture never fails a start.
   */
  async captureRepository(
    allocationRef: string,
    repoKey: string,
    commit?: string
  ): Promise<boolean> {
    const index = this.repoSnapshotIndex();
    const container = this.ctx.container;
    if (index === null || !container || container.running !== true) return false;
    if (!(await this.isRunningAllocation(allocationRef))) return false;
    const startedAt = Date.now();
    try {
      const snapshot = await withTimeout(
        container.snapshotContainer({}),
        REPO_CAPTURE_TIMEOUT_MS,
        'container snapshot timed out'
      );
      const snapshotMs = Date.now() - startedAt;
      if (!(await this.isRunningAllocation(allocationRef))) {
        logRepositoryCapture('abandoned', snapshotMs);
        return false;
      }
      const key = await repoSnapshotIndexKey(repoKey, this.containerImage());
      const stored = await index.store(key, {
        snapshotId: snapshot.id,
        ...(commit === undefined ? {} : { commit }),
      });
      logRepositoryCapture(stored ? 'stored' : 'index_unavailable', snapshotMs);
      return stored;
    } catch (error) {
      logRepositoryCapture('failed', Date.now() - startedAt, error);
      return false;
    }
  }

  private async isRunningAllocation(allocationRef: string): Promise<boolean> {
    const record = await this.readRecord();
    return record.state === 'running' && record.allocationRef === allocationRef;
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
    };
    if (phase === 'retain') {
      next.wrapperAttempt = 'exec_pending';
    } else {
      delete next.wrapperAttempt;
    }
    await this.writeRecord(next);
  }
}
