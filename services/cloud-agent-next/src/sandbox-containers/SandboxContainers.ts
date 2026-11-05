import {
  MAX_SNAPSHOT_START_FAILURES,
  SNAPSHOT_START_FAILURES_KEY,
  parseSnapshotStartFailures,
  recordSnapshotStartFailure,
} from './snapshot-start-failures.js';
import { getBillingContext } from '@kilocode/container-usage';
import { withTimeout } from '@kilocode/worker-utils';
import { DurableObject } from 'cloudflare:workers';
import { billingHeartbeatSeconds } from '../container-usage.js';
import { resolveControlPlaneTimers } from '../shared/control-plane-timers.js';
import { logger } from '../logger.js';
import {
  CONTROL_PROCESS_MATCH,
  CONTROL_WRAPPER_LOG_PATH,
} from '../sandbox-control/container-paths.js';
import { DEADLINE_MS } from '../sandbox-control/deadlines.js';
import {
  diagnosticCause,
  logControlDiagnostic,
  type ControlDiagnosticFields,
} from '../sandbox-control/diagnostics.js';
import { fetchPreviewPort, previewNotRunningResponse } from '../preview/container-port-fetch.js';
import { isReservedPreviewPort } from '../shared/reserved-ports.js';
import {
  ENVIRONMENT_BUILD_RUNNER_DELIVERY_SCRIPT,
  type EnvironmentBuildRunner,
} from '../shared/environment-build-protocol.js';
import {
  PREVIEW_MARKER_ALLOCATION_HEADER,
  PREVIEW_MARKER_PORT_HEADER,
} from '../shared/preview-headers.js';
import {
  ContainersBilling,
  ContainersBillingScheduler,
  resolveContainersBillingIdentity,
  unavailableContainersBillingAdmission,
  type ContainersBillingHost,
} from './containers-billing.js';
import {
  mainProcessObservationFields,
  observeCmdline,
  type MainProcessIdentity,
  type MainProcessObservation,
  type NativeMainProcess,
} from './main-process.js';
import {
  nativeLaunchEnv,
  planNativeStart,
  type ContainerInstanceSize,
  type ContainersStartSource,
  type NativeStartPlan,
  type NativeStartSnapshot,
} from './native-start.js';
import {
  CAPTURE_INDEX_KEY,
  captureKey,
  captureResult,
  parseCaptureIndex,
  parseCaptureRecord,
  retainCaptureIds,
  type CaptureRecord,
  type NativeCaptureResult,
} from './native-capture.js';
import type { Env } from '../types.js';
import type { ProviderStartupCommand } from '../sandbox-control/provider.js';
import { EgressAuditRequestSchema, type GetEgressAuditInput } from '../shared/egress-audit.js';
import { EgressAuditStore } from './egress-audit.js';
import {
  nativeEgressAllowlistSchema,
  nativeEgressPolicySchema,
  type NativeEgressPolicy,
} from './egress-policy.js';
import type { RuntimeStartupConfig } from '../shared/runtime-startup-config.js';

export type { ContainerInstanceSize, ContainersStartSource } from './native-start.js';
export type { NativeCaptureResult } from './native-capture.js';

export type ContainersState = 'idle' | 'launching' | 'running' | 'stopping';

export type ContainersLaunchInput = {
  allocationRef: string;
  command: ProviderStartupCommand;
  env: Record<string, string>;
  instance: ContainerInstanceSize;
  containment?: boolean;
  egressAllowlist?: string[];
  egressAudit?: boolean;
  /** Environment snapshot selected for this allocation; absent starts from the image. */
  snapshot?: NativeStartSnapshot;
  deadlineAt?: number;
  nativeImage?: RuntimeStartupConfig['image'];
};

/**
 * An environment builder start. The container DO named for one environment runs
 * only builders, from the image, with internet egress and no interception: the
 * builder holds a build-scoped repository credential, not contained aliases.
 */
const BUILDER_RUNNER_ENV = 'KILO_BUILDER_RUNNER';
/** Atomic, owner-only write of the runner file; the value comes from exec env. */

export type ContainersBuilderLaunchInput = {
  allocationRef: string;
  /** Written to the running builder by exec; the builder starts without it. */
  runner: EnvironmentBuildRunner;
  instance: ContainerInstanceSize;
  command: ProviderStartupCommand;
  deadlineAt: number;
};

export type ContainersLaunchResult = {
  started: boolean;
  startSource: ContainersStartSource;
  snapshotFailed?: true;
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
  /** Image selected for this allocation; absent on records written before image pinning. */
  startImage?: string;
  instance?: ContainerInstanceSize;
  billingConfigured?: true;
  wrapperAttempt?: WrapperAttempt;
  egressPolicy?: NativeEgressPolicy;
};

/** A start plan plus what the issued main process must be and how long it may take. */
type ResolvedStart = NativeStartPlan & {
  mainProcess: NativeMainProcess;
  command: ProviderStartupCommand;
};

/** A start that did not reach its main process, reported to the caller instead of thrown. */
type StartFailure = { snapshotFailed: true };

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
const RUNTIME_FREE_CONTAINER_IMAGE = 'runtime-free';

const PROBE_TIMEOUT_MS = 5_000;
const CONTAINER_CALL_TIMEOUT_MS = 5_000;
/** Pause between readiness probes, so repeated pgrep stays sequential and bounded. */
const WRAPPER_READINESS_POLL_MS = 1_000;
/** Bounds one snapshot capture. The environment coordinator's wait is a backstop over this. */
export const SNAPSHOT_CAPTURE_TIMEOUT_MS = 5 * 60_000;
const DESTROY_TIMEOUT_MS = 30_000;

/**
 * One line per capture, with how long the platform snapshot took and its size
 * when the platform returned one, so the capture bound can be tuned from real
 * durations. It carries no snapshot id or credential.
 */
function logSnapshotCapture(
  outcome: CaptureRecord['state'] | Extract<CaptureRecord, { state: 'failed' }>['reason'],
  durationMs: number,
  details: { size?: number; error?: unknown } = {}
): void {
  const { size, error } = details;
  const fields = logger.withFields({
    outcome,
    durationMs,
    ...(size === undefined ? {} : { size }),
    ...(error === undefined ? {} : { error: error instanceof Error ? error.message : 'unknown' }),
  });
  if (outcome === 'stored') fields.info('Environment snapshot captured');
  else fields.warn('Environment snapshot not captured');
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
  /** Snapshot calls still awaited in this isolate, by capture id. */
  private readonly inflightCaptures = new Map<string, Promise<NativeCaptureResult>>();
  private readonly egressAuditStore = new EgressAuditStore(this.ctx.storage);

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
    if (input.egressAudit !== undefined && typeof input.egressAudit !== 'boolean') {
      throw new Error('Invalid egress audit policy');
    }
    if (input.egressAudit === true) {
      EgressAuditRequestSchema.shape.allocationRef.parse(input.allocationRef);
    }
    input = {
      ...input,
      egressAllowlist: nativeEgressAllowlistSchema.optional().parse(input.egressAllowlist),
    };
    return this.runExclusive(async () => {
      const ref = input.allocationRef;
      let stored = await this.readRecord();
      if (stored.allocationRef === ref && stored.state === 'stopping') {
        throw new ContainersAllocationConflictError(ref);
      }
      if (stored.allocationRef !== null && stored.allocationRef !== ref) {
        stored = await this.releaseSupersededAllocation(stored);
      }
      const persistedPolicy = nativeEgressPolicySchema.optional().parse(stored.egressPolicy);
      if (stored.allocationRef === ref || persistedPolicy?.allocationRef === ref) {
        if (
          (persistedPolicy !== undefined && persistedPolicy.allocationRef !== ref) ||
          JSON.stringify(persistedPolicy?.allowlist) !== JSON.stringify(input.egressAllowlist) ||
          (persistedPolicy?.egressAudit === true) !== (input.egressAudit === true)
        ) {
          throw new Error('Container egress policy cannot change within an allocation');
        }
      }
      return this.launchEntry(stored, ref, input);
    });
  }

  /**
   * The Sandbox DO is this container's only caller and launches a new allocation
   * only after it has given up on the previous one. A record still held by an
   * older allocation is therefore a leftover (a lost cleanup, an abandoned
   * create), and the new launch destroys it. Refusing instead would reject every
   * later allocation, because none of them can name the leftover ref.
   */
  private async releaseSupersededAllocation(stored: ContainersRecord): Promise<ContainersRecord> {
    logControlDiagnostic(
      'container_superseded',
      { sandboxId: this.sandboxNameForLog(), previousState: stored.state },
      'warn'
    );
    if ((await this.stopRecord(stored)) === 'retryable') {
      throw new Error('Container from a superseded allocation could not be destroyed');
    }
    return this.readRecord();
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
      if (input.egressAllowlist !== undefined || input.egressAudit === true) {
        await this.installOutboundProxy(this.requiredContainer(), input);
      }
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
        return this.adoptUncertainWrapper(stored, ref, input, phase === 'missing');
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
    if (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt) {
      throw new WrapperExecTimeoutError();
    }
    if ((input.egressAllowlist !== undefined || input.egressAudit === true) && container.running) {
      throw new Error('Cannot apply an egress policy to an unowned running container');
    }
    // Persist the accepted physical instance before any early return or physical
    // operation, so a resumed launch whose exec fails still records its size.
    let record = await this.installLaunchInstance(stored, input.instance);
    if (input.egressAllowlist !== undefined || input.egressAudit === true) {
      record = {
        ...record,
        egressPolicy: {
          allocationRef: ref,
          allowlist: input.egressAllowlist,
          ...(input.egressAudit === true ? { egressAudit: true } : {}),
        },
      };
      await this.writeRecord(record);
    }
    if (
      input.containment === true ||
      input.egressAllowlist !== undefined ||
      input.egressAudit === true
    ) {
      await this.installOutboundProxy(container, input);
    }
    const start = await this.resolveStart(input, 'supervisor', true);
    return this.issueNativeMainProcess(record, ref, start, input, input.deadlineAt);
  }

  /**
   * Start an environment builder for `allocationRef`. Only the environment
   * coordinator calls this, on the container DO named for its environment, so a
   * record held by another allocation is a previous builder and is destroyed
   * first. A repeated call for the running builder retries runner delivery; a builder whose
   * start may still be in flight is confirmed by its main-process identity.
   */
  async launchBuilder(input: ContainersBuilderLaunchInput): Promise<ContainersLaunchResult> {
    return this.runExclusive(async () => {
      const ref = input.allocationRef;
      let stored = await this.readRecord();
      if (stored.allocationRef === ref && stored.state === 'stopping') {
        throw new ContainersAllocationConflictError(ref);
      }
      if (stored.allocationRef !== null && stored.allocationRef !== ref) {
        stored = await this.releaseSupersededAllocation(stored);
      }
      if (stored.allocationRef === ref && stored.state === 'running') {
        await this.deliverBuilderRunner(this.requiredContainer(), input.runner, input.deadlineAt);
        return { started: false, startSource: 'image' };
      }
      const container = this.requiredContainer();
      if (stored.allocationRef === ref && stored.state === 'launching') {
        if (container.running !== true) {
          throw new Error('Builder start is pending and the container is not running');
        }
        if (
          (await this.settleRunningMainProcess(
            stored,
            ref,
            'environment-builder',
            input.command
          )) !== 'issued'
        ) {
          throw new Error('Builder container main process is not the environment builder');
        }
        await this.deliverBuilderRunner(container, input.runner, input.deadlineAt);
        return { started: true, startSource: 'image' };
      }
      if (Date.now() >= input.deadlineAt) throw new WrapperExecTimeoutError();
      if (container.running) {
        throw new Error('Cannot start a builder on an unowned running container');
      }
      const record = await this.installLaunchInstance(stored, input.instance);
      const start = await this.resolveStart(
        {
          env: {},
          instance: input.instance,
          command: input.command,
          nativeImage: 'runtime-free',
        },
        'environment-builder',
        false
      );
      const result = await this.issueNativeMainProcess(
        record,
        ref,
        start,
        undefined,
        input.deadlineAt
      );
      if (result.started) {
        await this.deliverBuilderRunner(container, input.runner, input.deadlineAt);
      }
      return result;
    });
  }

  /**
   * Hand the started builder its endpoint and credential. Exec env is not part
   * of the start configuration a container snapshot keeps, so a session
   * restored from the snapshot never inherits them; the builder deletes the
   * file once read.
   */
  private async deliverBuilderRunner(
    container: Container,
    runner: EnvironmentBuildRunner,
    deadlineAt: number
  ): Promise<void> {
    if (Date.now() >= deadlineAt) throw new WrapperExecTimeoutError();
    const proc = await this.awaitContainerCall(
      container.exec(['/bin/sh', '-c', ENVIRONMENT_BUILD_RUNNER_DELIVERY_SCRIPT], {
        env: { [BUILDER_RUNNER_ENV]: JSON.stringify(runner) },
        cwd: '/',
      }),
      deadlineAt
    );
    const output = await this.awaitContainerCall(proc.output(), deadlineAt);
    if (output.exitCode !== 0) throw new Error('Builder runner delivery failed');
  }

  /**
   * Issue a native main process as PID 1: fence, start, confirm identity, mark
   * running. Containment is installed by the caller, which owns its ordering
   * before any physical call.
   */
  private async issueNativeMainProcess(
    record: ContainersRecord,
    ref: string,
    start: ResolvedStart,
    policy: Pick<ContainersLaunchInput, 'egressAllowlist' | 'egressAudit'> | undefined,
    deadlineAt: number | undefined
  ): Promise<ContainersLaunchResult> {
    const container = this.requiredContainer();
    // Ownership is retained before start: an ambiguous start that takes effect
    // must not release the allocation. Never leave `not_started` across the start.
    const launching: ContainersRecord = {
      ...record,
      state: 'launching',
      allocationRef: ref,
      stopOpId: null,
      wrapperAttempt: 'exec_pending',
      startSource: start.source,
      startImage: start.image,
    };
    if (policy?.egressAllowlist === undefined && policy?.egressAudit !== true) {
      delete launching.egressPolicy;
    } else {
      launching.egressPolicy = {
        allocationRef: ref,
        allowlist: policy.egressAllowlist,
        ...(policy.egressAudit === true ? { egressAudit: true } : {}),
      };
    }
    await this.writeRecord(launching);
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
      throw new WrapperExecTimeoutError();
    }
    const failure = await this.runStart(start, async () => {
      const issuedAt = Date.now();
      await this.startContainerAndActivateBilling(container, record, start.options);
      await this.awaitMainProcess(container, start, issuedAt, deadlineAt);
      await this.activateBillingIfRunning(container, record);
    });
    if (failure !== null) return { started: false, startSource: start.source, ...failure };
    await this.writeRunning(ref, 'clear');
    return { started: true, startSource: start.source };
  }

  /**
   * The start plan for one launch. A session start may use the offered
   * environment snapshot; a builder always starts from the image. Emits one
   * `snapshot_lookup` diagnostic per start so `image` vs `repository` and the
   * reason are visible. Like the capture line it carries no snapshot handle.
   */
  private async resolveStart(
    input: Pick<
      ContainersLaunchInput,
      | 'env'
      | 'instance'
      | 'containment'
      | 'egressAllowlist'
      | 'egressAudit'
      | 'snapshot'
      | 'command'
      | 'nativeImage'
    >,
    mainProcess: NativeMainProcess,
    allowSnapshot: boolean
  ): Promise<ResolvedStart> {
    const failures =
      input.snapshot === undefined
        ? []
        : parseSnapshotStartFailures(await this.ctx.storage.get(SNAPSHOT_START_FAILURES_KEY));
    const snapshotRejected =
      input.snapshot !== undefined &&
      (failures.find(record => record.snapshotId === input.snapshot?.snapshotId)?.failures ?? 0) >=
        MAX_SNAPSHOT_START_FAILURES;
    const plan = planNativeStart(
      {
        image: this.containerImage(input.nativeImage ?? 'all-in-one'),
        instance: input.instance,
        mainProcess,
        env: input.env,
        interception:
          input.containment === true ||
          input.egressAllowlist !== undefined ||
          input.egressAudit === true,
        ...(input.egressAllowlist === undefined ? {} : { egressAllowlist: input.egressAllowlist }),
        command: input.command,
        ...(input.snapshot === undefined ? {} : { snapshot: input.snapshot }),
      },
      allowSnapshot && !snapshotRejected
    );
    if (snapshotRejected) plan.reason = 'restore_failures';
    logControlDiagnostic('snapshot_lookup', {
      sandboxId: this.sandboxNameForLog(),
      source: plan.source,
      reason: plan.reason,
      mainProcess,
      downloaded: input.command.argv.length > 2,
    });
    return {
      ...plan,
      mainProcess,
      command: input.command,
    };
  }

  private sandboxNameForLog(): string {
    return this.ctx.id.name ?? this.ctx.id.toString();
  }

  /**
   * Run one physical start. A failed snapshot start is reported, not thrown, so
   * the caller can retry the same allocation from the image once. A runtime
   * installer that exited with a typed code is reported the same way, so the
   * provider maps it to its reason. Every other failure throws.
   */
  private async runStart(
    start: ResolvedStart,
    attempt: () => Promise<void>
  ): Promise<StartFailure | null> {
    try {
      await attempt();
      return null;
    } catch (error) {
      if (start.source === 'repository' && start.snapshotId !== null) {
        const failures = parseSnapshotStartFailures(
          await this.ctx.storage.get(SNAPSHOT_START_FAILURES_KEY)
        );
        await this.ctx.storage.put(
          SNAPSHOT_START_FAILURES_KEY,
          recordSnapshotStartFailure(failures, start.snapshotId)
        );
        logControlDiagnostic('snapshot_start_failed', {
          sandboxId: this.sandboxNameForLog(),
          reason: 'repository_start_failed',
          errorName: error instanceof Error ? diagnosticCause(error.name) : 'unknown',
          cause: error instanceof Error ? diagnosticCause(error.message) : 'unknown',
        });
        return { snapshotFailed: true };
      }
      throw error;
    }
  }

  async observe(_allocationRef: string): Promise<ContainersObservation> {
    const record = await this.readRecord();
    return {
      running: this.ctx.container?.running === true,
      state: record.state,
      currentAllocationRef: record.allocationRef,
    };
  }

  async recordEgressRequest(input: unknown) {
    return this.egressAuditStore.recordEgressRequest(input);
  }

  async getEgressAudit(input: GetEgressAuditInput = {}) {
    return this.egressAuditStore.getEgressAudit(input);
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

  /**
   * Preview port fetches arrive as a marked request; every other request is a
   * 404. The record is re-read after the last await and immediately before
   * admission, so a stale resolve cannot reach a replacement container.
   */
  async fetch(request: Request): Promise<Response> {
    const marker = request.headers.get(PREVIEW_MARKER_PORT_HEADER);
    if (marker === null) return new Response('Not found', { status: 404 });
    const allocationRef = request.headers.get(PREVIEW_MARKER_ALLOCATION_HEADER);
    if (allocationRef === null) return previewNotRunningResponse();
    const container = this.ctx.container;
    if (!container) return previewNotRunningResponse();
    if (!(await this.isRunningAllocation(allocationRef))) return previewNotRunningResponse();
    return fetchPreviewPort(container, Number.parseInt(marker, 10), request, port =>
      isReservedPreviewPort('cloudflare-containers', port)
    );
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
      return this.stopRecord(record);
    });
  }

  /** Persist `stopping` for the record's allocation, then destroy the container. */
  private async stopRecord(record: ContainersRecord): Promise<'terminal' | 'retryable'> {
    if (record.state === 'stopping') {
      if (record.stopOpId === null) {
        await this.writeRecord({ ...record, stopOpId: crypto.randomUUID() });
      }
      return this.finishStop(record);
    }
    const stopping: ContainersRecord = {
      ...record,
      state: 'stopping',
      stopOpId: crypto.randomUUID(),
    };
    await this.writeRecord(stopping);
    return this.finishStop(stopping);
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
    const interception =
      input.containment === true ||
      input.egressAllowlist !== undefined ||
      input.egressAudit === true;
    if (interception) await this.installOutboundProxy(container, input);
    if (!container.running) {
      const start = await this.resolveStart(
        input,
        'supervisor',
        record.startSource === 'repository'
      );
      return this.issueNativeMainProcess(record, ref, start, input, input.deadlineAt);
    }
    if (
      (await this.settleRunningMainProcess(record, ref, 'supervisor', input.command)) === 'issued'
    ) {
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
      await this.startWrapper(container, input.command, input.env, interception);
    } else {
      await this.activateBillingIfRunning(container, record);
    }
    await this.writeRunning(ref, 'clear');
    return { started: true, startSource: recordedStartSource(record) };
  }

  /**
   * Settle the PID 1 identity of an already-running container. The expected
   * main process completes issuance (billing + running); an ambiguous or
   * different identity meters the stored generation and throws. The image
   * default `sleep infinity` returns to the caller, which owns the sleep-path
   * probe/exec.
   */
  private async settleRunningMainProcess(
    record: ContainersRecord,
    ref: string,
    expected: NativeMainProcess,
    command: ProviderStartupCommand
  ): Promise<'issued' | 'sleep'> {
    const container = this.requiredContainer();
    const identity = await this.readMainProcessIdentity(container, command);
    if (identity === expected || identity === 'startup') {
      await this.activateBillingIfRunning(container, record);
      await this.writeRunning(ref, 'clear');
      return 'issued';
    }
    if (identity === 'sleep') return 'sleep';
    await this.activateBillingIfRunning(container, record);
    throw new Error('Main process identity is ambiguous');
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
    input: ContainersLaunchInput,
    stampLegacy: boolean
  ): Promise<ContainersLaunchResult> {
    const container = this.requiredContainer();
    if (container.running !== true) {
      throw new Error('Container wrapper start is pending and the container is not running');
    }
    if (
      input.containment === true ||
      input.egressAllowlist !== undefined ||
      input.egressAudit === true
    ) {
      await this.installOutboundProxy(container, input);
    }
    if (
      (await this.settleRunningMainProcess(stored, ref, 'supervisor', input.command)) === 'issued'
    ) {
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
    command: ProviderStartupCommand,
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
      const handle = await this.awaitWrapperExec(container, command, env, containment, deadlineAt);
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
    command: ProviderStartupCommand,
    env: Record<string, string>,
    containment: boolean,
    deadlineAt: number
  ): Promise<ExecProcess> {
    // Absolute check at the native invocation boundary: no exec may begin at or
    // after expiry.
    if (Date.now() >= deadlineAt) throw new WrapperExecTimeoutError();
    return this.awaitContainerCall(
      container.exec([...command.argv], {
        env: nativeLaunchEnv(env, containment),
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

  private async installOutboundProxy(
    container: Container,
    input: ContainersLaunchInput
  ): Promise<void> {
    const outbound = this.ctx.exports.ContainersOutbound;
    const worker = outbound({
      props: {
        containerId: this.ctx.id.toString(),
        ...(input.egressAllowlist === undefined ? {} : { egressAllowlist: input.egressAllowlist }),
        ...(input.egressAudit === true
          ? { egressAudit: true, allocationRef: input.allocationRef }
          : {}),
      },
    });
    await container.interceptOutboundHttps('*', worker);
    await container.interceptAllOutboundHttp(worker);
  }

  private requiredContainer(): Container {
    const container = this.ctx.container;
    if (!container) throw new Error('Container is unavailable');
    return container;
  }

  private async readMainProcessIdentity(
    container: Container,
    command: ProviderStartupCommand
  ): Promise<MainProcessIdentity> {
    return (await this.observeMainProcess(container, command, Date.now() + PROBE_TIMEOUT_MS))
      .identity;
  }

  private async observeMainProcess(
    container: Container,
    command: ProviderStartupCommand,
    deadlineAt: number
  ): Promise<MainProcessObservation> {
    try {
      const proc = await this.awaitContainerCall(
        container.exec(['cat', '/proc/1/cmdline']),
        deadlineAt
      );
      const output = await this.awaitContainerCall(proc.output(), deadlineAt);
      if (output.exitCode !== 0) {
        return { kind: 'exit_code', identity: 'ambiguous', exitCode: output.exitCode };
      }
      return observeCmdline(new Uint8Array(output.stdout), command);
    } catch (error) {
      if (error instanceof WrapperExecTimeoutError)
        return { kind: 'deadline', identity: 'ambiguous' };
      return { kind: 'error', identity: 'ambiguous', error };
    }
  }

  /**
   * Confirm the native start issued its main process as PID 1, bounded by the
   * start-source readiness deadline. This is identity, not a wrapper-child
   * poll: a deadline without a match, or a container that stops first, throws
   * and does not exec. A runtime installer start is bounded by its own launch
   * deadline instead, because the installer runs before the handoff.
   *
   * Emits one `supervisor_confirm` diagnostic on a match (time to ready since the
   * start was issued) or at the deadline. The read in flight at the deadline is
   * usually cut off, so the timeout reports the last read that completed.
   */
  private async awaitMainProcess(
    container: Container,
    start: ResolvedStart,
    issuedAt: number,
    launchDeadlineAt?: number
  ): Promise<void> {
    const readinessDeadline =
      start.source === 'repository'
        ? issuedAt + DEADLINE_MS.repositoryStartup
        : Date.now() + DEADLINE_MS.wrapperReadiness;
    const deadlineAt = Math.min(readinessDeadline, launchDeadlineAt ?? Infinity);
    let checks = 0;
    let lastCompleted: MainProcessObservation | null = null;
    const stopped = container.monitor().then(
      () => ({
        type: 'stopped' as const,
        observation: { kind: 'exit_code', identity: 'ambiguous', exitCode: 0 } as const,
      }),
      (error: unknown) => ({
        type: 'stopped' as const,
        observation: { kind: 'error', identity: 'ambiguous', error } as const,
      })
    );
    for (;;) {
      const result = await Promise.race([
        this.observeMainProcess(container, start.command, deadlineAt).then(observation => ({
          type: 'observed' as const,
          observation,
        })),
        stopped,
      ]);
      const observation = result.observation;
      checks += 1;
      if (result.type === 'stopped') {
        this.logSupervisorConfirm(
          'stopped',
          start,
          issuedAt,
          checks,
          mainProcessObservationFields(observation)
        );
        throw new Error('Container stopped before the main process was confirmed');
      }
      if (observation.kind !== 'deadline') lastCompleted = observation;
      if (observation.identity === start.mainProcess || observation.identity === 'startup') {
        this.logSupervisorConfirm('ready', start, issuedAt, checks);
        return;
      }
      if (Date.now() >= deadlineAt) {
        this.logSupervisorConfirm('timeout', start, issuedAt, checks, {
          finalCutOff: observation.kind === 'deadline',
          ...mainProcessObservationFields(lastCompleted),
        });
        throw new WrapperExecTimeoutError();
      }
      await this.sleepWithinDeadline(deadlineAt);
    }
  }

  private logSupervisorConfirm(
    result: 'ready' | 'timeout' | 'stopped',
    start: ResolvedStart,
    issuedAt: number,
    checks: number,
    fields: ControlDiagnosticFields = {}
  ): void {
    logControlDiagnostic(
      'supervisor_confirm',
      {
        sandboxId: this.sandboxNameForLog(),
        result,
        source: start.source,
        mainProcess: start.mainProcess,
        downloaded: start.command.argv.length > 2,
        elapsedMs: Date.now() - issuedAt,
        checks,
        ...fields,
      },
      result === 'ready' ? 'info' : 'warn'
    );
  }

  private containerImage(nativeImage: RuntimeStartupConfig['image']): string {
    const imageName =
      nativeImage === 'runtime-free' ? RUNTIME_FREE_CONTAINER_IMAGE : CONTAINER_IMAGE;
    const image = this.requiredContainer().images[imageName];
    if (image === undefined) {
      throw new Error(`Container image "${imageName}" is unavailable`);
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
      ...(record.egressPolicy === undefined ? {} : { egressPolicy: record.egressPolicy }),
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
   * Snapshot the running container's root filesystem under `captureId` (plan
   * step 8). The outcome is stored under that id before this replies, so a caller
   * that lost the reply reads it back with `readCapture`. A repeated call returns
   * the stored outcome and never snapshots twice; an issued capture whose call is
   * no longer running in this isolate is `uncertain`. It does not take the
   * operation queue: a capture of unknown duration must not delay a stop.
   */
  async captureSnapshot(allocationRef: string, captureId: string): Promise<NativeCaptureResult> {
    const key = captureKey(captureId);
    const inflight = this.inflightCaptures.get(captureId);
    if (inflight) return inflight;
    const existing = parseCaptureRecord(await this.ctx.storage.get(key));
    if (existing !== null) return captureResult(existing, false);
    const capture = this.runCapture(allocationRef, captureId, key);
    this.inflightCaptures.set(captureId, capture);
    try {
      return await capture;
    } finally {
      this.inflightCaptures.delete(captureId);
    }
  }

  /** The stored outcome of one capture, or null when this DO never recorded it. */
  /** The image a launch uses now; environment snapshots must match it. */
  async currentImage(nativeImage: RuntimeStartupConfig['image']): Promise<string> {
    return this.containerImage(nativeImage);
  }

  async readCapture(captureId: string): Promise<NativeCaptureResult | null> {
    const record = parseCaptureRecord(await this.ctx.storage.get(captureKey(captureId)));
    if (record === null) return null;
    return captureResult(record, this.inflightCaptures.has(captureId));
  }

  private async runCapture(
    allocationRef: string,
    captureId: string,
    key: string
  ): Promise<NativeCaptureResult> {
    const container = this.ctx.container;
    if (
      !container ||
      container.running !== true ||
      !(await this.isRunningAllocation(allocationRef))
    ) {
      return this.storeCapture(captureId, key, {
        state: 'failed',
        allocationRef,
        reason: 'not_running',
      });
    }
    const baseImage = (await this.readRecord()).startImage ?? this.containerImage('all-in-one');
    // Issued evidence goes down before the platform call: after a restart an
    // issued record without a result is uncertain, never a reason to retry.
    await this.storeCapture(captureId, key, {
      state: 'issued',
      allocationRef,
      issuedAt: Date.now(),
    });
    const startedAt = Date.now();
    let snapshot: ContainerSnapshot;
    try {
      snapshot = await withTimeout(
        container.snapshotContainer({}),
        SNAPSHOT_CAPTURE_TIMEOUT_MS,
        'container snapshot timed out'
      );
    } catch (error) {
      logSnapshotCapture('snapshot_failed', Date.now() - startedAt, { error });
      return this.storeCapture(captureId, key, {
        state: 'failed',
        allocationRef,
        reason: 'snapshot_failed',
      });
    }
    const durationMs = Date.now() - startedAt;
    const size = Number.isFinite(snapshot.size) ? snapshot.size : undefined;
    if (!(await this.isRunningAllocation(allocationRef))) {
      logSnapshotCapture('abandoned', durationMs, { size });
      return this.storeCapture(captureId, key, {
        state: 'failed',
        allocationRef,
        reason: 'abandoned',
      });
    }
    logSnapshotCapture('stored', durationMs, { size });
    // The capture start bounds the contents' age from above, so an age shown on
    // use never understates how stale the snapshot is.
    return this.storeCapture(captureId, key, {
      state: 'stored',
      allocationRef,
      snapshotId: snapshot.id,
      ...(size === undefined ? {} : { size }),
      capturedAt: startedAt,
      baseImage,
      durationMs,
    });
  }

  private async storeCapture(
    captureId: string,
    key: string,
    record: CaptureRecord
  ): Promise<NativeCaptureResult> {
    const { index, evicted } = retainCaptureIds(
      parseCaptureIndex(await this.ctx.storage.get(CAPTURE_INDEX_KEY)),
      captureId
    );
    await this.ctx.storage.put({ [key]: record, [CAPTURE_INDEX_KEY]: index });
    if (evicted.length > 0) await this.ctx.storage.delete(evicted.map(id => captureKey(id)));
    return captureResult(record, record.state === 'issued');
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
