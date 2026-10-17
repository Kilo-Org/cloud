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
import { DEADLINE_MS, leaseAtLeastMs } from '../sandbox-control/deadlines.js';
import {
  diagnosticCause,
  logControlDiagnostic,
  type ControlDiagnosticFields,
} from '../sandbox-control/diagnostics.js';
import { fetchPreviewPort, previewNotRunningResponse } from '../preview/container-port-fetch.js';
import { isReservedPreviewPort } from '../shared/reserved-ports.js';
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
  decideStartSource,
  createRepoSnapshotIndex,
  repoSnapshotIndexKey,
  type RepoSnapshotIndex,
} from './repo-snapshot-index.js';
import {
  mainProcessObservationFields,
  observeCmdline,
  type MainProcessIdentity,
  type MainProcessObservation,
} from './main-process.js';
import type { Env } from '../types.js';
import {
  nativeEgressAllowlistSchema,
  nativeEgressPolicySchema,
  type NativeEgressPolicy,
} from './egress-policy.js';
import {
  NATIVE_LAUNCH_LABEL,
  NATIVE_RETIREMENT_CAP,
  isRetired,
  nativeAttemptDeadlineAt,
  nativeLaunchEvidence,
  nativeLaunchLabels,
  nativeLaunchTokenMatches,
  nativeProcessObservation,
  nativeReceiptDeleteCommand,
  nativeReceiptReadCommand,
  pruneRetirements,
  readNativeLaunchRecord,
  nativeRuntimeProtocolSchema,
  readRetirements,
  recordRetirement,
  withoutArtifactEnv,
  type NativeAckRequest,
  type NativeDestroyRequest,
  type NativeLaunchEvidence,
  type NativeLaunchRecord,
  type NativeLaunchSettlement,
  type NativeLaunchToken,
  type NativeObserveRequest,
  type NativeReserveRequest,
  type NativeRetireRequest,
  type NativeRetirementFence,
  type NativeSettleRequest,
  type NativeStartRequest,
  type NativeStopEvidence,
} from './native-launch.js';
import type {
  RuntimeLaunchObservation,
  RuntimeLaunchProcessObservation,
} from '../sandbox-control/runtime-launch-phase.js';
import type {
  RuntimeReserveResult,
  RuntimeStartResult,
} from '../sandbox-control/runtime-launch.js';
import { CLOUDFLARE_CONTAINERS_DEFAULT_INSTANCE } from '@kilocode/worker-utils/sandbox-allocation';

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
  egressAllowlist?: string[];
  /** Keyed hash of the launch's scope, repository and env; absent means no snapshot. */
  repoKey?: string;
  /** Start from the image and retain the failed snapshot for debugging. */
  skipRepository?: true;
  deadlineAt?: number;
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
  runtimeProtocolVersion?: 1;
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
  repositoryStartFailures?: { snapshotId: string; attempts: number };
  egressPolicy?: NativeEgressPolicy;
  /** The reserved native launch plan and issuance evidence; absent on legacy records. */
  nativeLaunch?: NativeLaunchRecord;
  /** Retired launch nonces kept through the outer allocation deadline. */
  retirements?: NativeRetirementFence[];
  lastNativeStop?: NativeStopEvidence;
};

type ResolvedStart = {
  source: ContainersStartSource;
  options: ContainerStartupOptions;
  snapshotId: string | null;
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

function interceptedProcessEnv(env: Record<string, string>): Record<string, string> {
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
/** Bounds one repository capture. The wrapper's own wait is a backstop over this. */
const REPO_CAPTURE_TIMEOUT_MS = 5 * 60_000;
const DESTROY_TIMEOUT_MS = 30_000;

type RepositoryCaptureOutcome = 'stored' | 'index_unavailable' | 'abandoned' | 'failed';

/**
 * One line per capture, with how long the platform snapshot took and its size
 * when the platform returned one, so the capture bound can be tuned from real
 * durations. It carries no key, id or credential.
 */
function logRepositoryCapture(
  outcome: RepositoryCaptureOutcome,
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
    input = {
      ...input,
      egressAllowlist: nativeEgressAllowlistSchema.optional().parse(input.egressAllowlist),
    };
    return this.runExclusive(async () => {
      const ref = input.allocationRef;
      let stored = await this.readRecord();
      if (stored.runtimeProtocolVersion === 1 || stored.nativeLaunch !== undefined)
        throw new Error('Versioned native ownership requires a launch token');
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
          JSON.stringify(persistedPolicy?.allowlist) !== JSON.stringify(input.egressAllowlist)
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
      if (input.egressAllowlist !== undefined) {
        await this.installOutboundProxy(this.requiredContainer(), input.egressAllowlist);
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
    if (input.egressAllowlist !== undefined && container.running) {
      throw new Error('Cannot apply an egress policy to an unowned running container');
    }
    // Persist the accepted physical instance before any early return or physical
    // operation, so a resumed launch whose exec fails still records its size.
    const record = await this.installLaunchInstance(stored, input.instance);
    if (input.containment === true || input.egressAllowlist !== undefined) {
      await this.installOutboundProxy(container, input.egressAllowlist);
    }
    const start = await this.resolveStart(input, true);
    return this.issueNativeSupervisor(record, ref, start, input);
  }

  /**
   * Issue the native supervisor as PID 1: fence, start, confirm identity, mark
   * running. Containment is installed by the caller, which owns its ordering
   * before any physical call.
   */
  private async issueNativeSupervisor(
    record: ContainersRecord,
    ref: string,
    start: ResolvedStart,
    input: ContainersLaunchInput
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
    };
    if (input.egressAllowlist === undefined) {
      delete launching.egressPolicy;
    } else {
      launching.egressPolicy = { allocationRef: ref, allowlist: input.egressAllowlist };
    }
    await this.writeRecord(launching);
    if (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt) {
      throw new WrapperExecTimeoutError();
    }
    const issuedAt = Date.now();
    // Only the physical start is wrapped: a confirmed snapshot start rejection
    // counts, but a readiness/identity failure must not poison the snapshot.
    const started = await this.runStart(start, () =>
      this.startContainerAndActivateBilling(container, record, start.options)
    );
    if (!started) return { started: false, startSource: 'repository', snapshotFailed: true };
    await this.awaitSupervisorMainProcess(container, start.source, issuedAt, input.deadlineAt);
    await this.writeRunning(ref, 'clear');
    return { started: true, startSource: start.source };
  }

  /**
   * The one start-source rule: a physical start uses the repository snapshot for
   * the launch's `repoKey` and this image when the index has one, and the image
   * otherwise. Failed snapshots are retained and retried before image fallback.
   *
   * Emits one `snapshot_lookup` diagnostic per start so `image` vs `repository`
   * and the reason (no key, no index, miss, exhausted, skipped, not allowed) are visible.
   * A hit adds the snapshot's age and size. Like the capture line it carries no
   * repository key; the key is logged by the Sandbox DO, which owns it.
   */
  private async resolveStart(
    input: ContainersLaunchInput,
    allowRepository: boolean
  ): Promise<ResolvedStart> {
    const decision = await decideStartSource({
      index: this.repoSnapshotIndex(),
      image: this.containerImage(),
      repoKey: input.repoKey,
      skipRepository: input.skipRepository === true,
      allowRepository,
      failures: (await this.readRecord()).repositoryStartFailures,
    });
    const env = this.nativeLaunchEnv(
      input.env,
      input.containment === true || input.egressAllowlist !== undefined
    );
    if (decision.kind === 'image') {
      this.logSnapshotLookup('image', decision.reason, {
        ...(decision.attempts === undefined ? {} : { attempts: decision.attempts }),
      });
      return {
        source: 'image',
        options: this.startOptions(input.instance, env, input.egressAllowlist),
        snapshotId: null,
      };
    }
    this.logSnapshotLookup('repository', decision.reason, {
      ...(decision.ageMs === undefined ? {} : { ageMs: decision.ageMs }),
      ...(decision.size === undefined ? {} : { size: decision.size }),
    });
    return {
      source: 'repository',
      options: this.startOptions(input.instance, env, input.egressAllowlist, decision.snapshotId),
      snapshotId: decision.snapshotId,
    };
  }

  private sandboxNameForLog(): string {
    return this.ctx.id.name ?? this.ctx.id.toString();
  }

  private logSnapshotLookup(
    source: ContainersStartSource,
    reason: string,
    fields: ControlDiagnosticFields = {}
  ): void {
    logControlDiagnostic('snapshot_lookup', {
      sandboxId: this.sandboxNameForLog(),
      source,
      reason,
      ...fields,
    });
  }

  /** Count failed snapshot starts durably without changing the shared snapshot index. */
  private async runStart(start: ResolvedStart, attempt: () => Promise<void>): Promise<boolean> {
    try {
      await attempt();
      return true;
    } catch (error) {
      if (start.source === 'repository' && start.snapshotId !== null) {
        const record = await this.readRecord();
        const previous = record.repositoryStartFailures;
        const attempts = (previous?.snapshotId === start.snapshotId ? previous.attempts : 0) + 1;
        await this.writeRecord({
          ...record,
          repositoryStartFailures: { snapshotId: start.snapshotId, attempts },
        });
        logControlDiagnostic('snapshot_start_failed', {
          sandboxId: this.sandboxNameForLog(),
          reason: 'repository_start_failed',
          attempts,
          errorName: error instanceof Error ? diagnosticCause(error.name) : 'unknown',
          cause: error instanceof Error ? diagnosticCause(error.message) : 'unknown',
        });
        return false;
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
    // Retire a versioned nonce before destroying so a delayed reserve of the same
    // nonce cannot resurrect the allocation after the container is gone.
    const record = await this.readRecord();
    const token = this.launchTokenForRecord(record);
    if (token !== undefined) {
      const retired = await this.retireNativeToken(record, token.launchId, token.createDeadlineAt);
      // No destruction without a confirmed fence.
      if (retired === null) throw new Error('Native retirement fence is saturated');
    }
    await container.destroy();
    const current = await this.readRecord();
    await this.writeRecord(this.terminalRecord(current));
    await this.settleBillingAtStop(current);
  }

  async getBillingRuntimeStatus() {
    const billing = this.billingForRecord(await this.readRecord());
    return billing?.getBillingRuntimeStatus();
  }

  async billingForceStop(generation: string): Promise<void> {
    const billing = this.billingForRecord(await this.readRecord());
    await billing?.billingForceStop(generation);
  }

  async stop(
    allocationRef: string | null,
    expectedToken?: NativeLaunchToken
  ): Promise<'terminal' | 'retryable'> {
    return this.runExclusive(async () => {
      let record = await this.readRecord();
      // Persist a Stop's captured token BEFORE any destruction, including a Stop
      // that arrives before the allocation has reserved a plan.
      if (expectedToken !== undefined) {
        const retired = await this.retireNativeToken(
          record,
          expectedToken.launchId,
          expectedToken.createDeadlineAt
        );
        if (retired === null) return stopPath('retirement_saturated', 'retryable');
        record = await this.readRecord();
      }
      if (record.allocationRef === null) return stopPath('no_allocation', 'terminal');
      const nativeRead = readNativeLaunchRecord(record.nativeLaunch);
      if (nativeRead.kind === 'invalid') return stopPath('metadata_invalid', 'retryable');
      if (allocationRef === null) {
        // A null ref may only destroy the current container when the captured
        // token exactly matches the live plan; it never fabricates a ref.
        if (expectedToken === undefined) return stopPath('null_ref_tokenless', 'retryable');
        if (nativeRead.kind !== 'valid') return stopPath('null_ref_no_plan', 'terminal');
        if (!nativeLaunchTokenMatches(nativeRead.record, expectedToken)) {
          return stopPath('null_ref_stale_token', 'terminal');
        }
      } else {
        if (record.allocationRef !== allocationRef && record.state !== 'stopping') {
          return stopPath('other_allocation', 'terminal');
        }
        if (record.allocationRef !== allocationRef) {
          return stopPath('other_allocation_stopping', 'retryable');
        }
        // A versioned launch may only be destroyed by its own captured token; a
        // tokenless legacy Stop must never destroy a versioned replacement.
        if (nativeRead.kind === 'valid') {
          if (expectedToken === undefined) return stopPath('versioned_tokenless', 'retryable');
          if (nativeRead.record.launchId !== expectedToken.launchId) {
            return stopPath('stale_token', 'terminal');
          }
        }
      }
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
    const interception = input.containment === true || input.egressAllowlist !== undefined;
    if (interception) await this.installOutboundProxy(container, input.egressAllowlist);
    if (!container.running) {
      const start = await this.resolveStart(input, record.startSource === 'repository');
      return this.issueNativeSupervisor(record, ref, start, input);
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
      await this.startWrapper(container, input.env, interception);
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
    input: ContainersLaunchInput,
    stampLegacy: boolean
  ): Promise<ContainersLaunchResult> {
    const container = this.requiredContainer();
    if (container.running !== true) {
      throw new Error('Container wrapper start is pending and the container is not running');
    }
    if (input.containment === true || input.egressAllowlist !== undefined) {
      await this.installOutboundProxy(container, input.egressAllowlist);
    }
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

  private async installOutboundProxy(
    container: Container,
    egressAllowlist?: string[]
  ): Promise<void> {
    const outbound = this.ctx.exports.ContainersOutbound;
    const worker = outbound({
      props: {
        containerId: this.ctx.id.toString(),
        ...(egressAllowlist === undefined ? {} : { egressAllowlist }),
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

  /** Read the live running flag without letting an earlier check narrow it. */
  private containerRunningNow(): boolean {
    return this.ctx.container?.running === true;
  }

  private startOptions(
    instance: ContainerInstanceSize,
    env: Record<string, string>,
    egressAllowlist?: string[],
    snapshotId?: string
  ): ContainerStartupOptions {
    // Native issuance: the main process is the supervisor, not the image default
    // `sleep infinity`. The supervisor script is already in the image.
    return {
      ...(snapshotId === undefined
        ? { image: this.containerImage() }
        : { containerSnapshot: { id: snapshotId } }),
      instance,
      enableInternet: egressAllowlist === undefined,
      entrypoint: ['/bin/sh', CONTROL_SUPERVISOR_PATH],
      env,
    };
  }

  /**
   * The env for a native start and for a sleep-main-process exec. Interception CA
   * goes on both; the stderr gate is native-only and set here, never in the
   * shared launch-env builder.
   */
  private nativeLaunchEnv(
    env: Record<string, string>,
    interception: boolean
  ): Record<string, string> {
    return {
      ...(interception ? interceptedProcessEnv(env) : env),
      [CONTROL_PLANE_NATIVE_LOGS_ENV]: '1',
    };
  }

  private async readMainProcessIdentity(container: Container): Promise<MainProcessIdentity> {
    return (await this.observeMainProcess(container, Date.now() + PROBE_TIMEOUT_MS)).identity;
  }

  private async observeMainProcess(
    container: Container,
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
      return observeCmdline(new Uint8Array(output.stdout));
    } catch (error) {
      if (error instanceof WrapperExecTimeoutError)
        return { kind: 'deadline', identity: 'ambiguous' };
      return { kind: 'error', identity: 'ambiguous', error };
    }
  }

  /**
   * Confirm the native start issued the supervisor as PID 1, bounded by the
   * start-source readiness deadline. This is identity, not a wrapper-child
   * poll: a deadline without a match, or a container that stops first, throws
   * and does not exec.
   *
   * Emits one `supervisor_confirm` diagnostic on a match (time to ready since the
   * start was issued) or at the deadline. The read in flight at the deadline is
   * usually cut off, so the timeout reports the last read that completed.
   */
  private async awaitSupervisorMainProcess(
    container: Container,
    source: ContainersStartSource,
    issuedAt: number,
    launchDeadlineAt?: number
  ): Promise<void> {
    const deadlineAt = Math.min(
      source === 'repository'
        ? issuedAt + DEADLINE_MS.repositoryStartup
        : Date.now() + DEADLINE_MS.wrapperReadiness,
      launchDeadlineAt ?? Infinity
    );
    let checks = 0;
    let lastCompleted: MainProcessObservation | null = null;
    for (;;) {
      if (container.running !== true) {
        throw new Error('Container stopped before the supervisor main process was confirmed');
      }
      const observation = await this.observeMainProcess(container, deadlineAt);
      checks += 1;
      if (observation.kind !== 'deadline') lastCompleted = observation;
      if (observation.identity === 'supervisor') {
        this.logSupervisorConfirm('ready', source, issuedAt, checks);
        return;
      }
      if (Date.now() >= deadlineAt) {
        this.logSupervisorConfirm('timeout', source, issuedAt, checks, {
          finalCutOff: observation.kind === 'deadline',
          ...mainProcessObservationFields(lastCompleted),
        });
        throw new WrapperExecTimeoutError();
      }
      await this.sleepWithinDeadline(deadlineAt);
    }
  }

  private logSupervisorConfirm(
    result: 'ready' | 'timeout',
    source: ContainersStartSource,
    issuedAt: number,
    checks: number,
    fields: ControlDiagnosticFields = {}
  ): void {
    logControlDiagnostic(
      'supervisor_confirm',
      {
        sandboxId: this.sandboxNameForLog(),
        result,
        source,
        elapsedMs: Date.now() - issuedAt,
        checks,
        ...fields,
      },
      result === 'ready' ? 'info' : 'warn'
    );
  }

  private containerImage(): string {
    const image = this.requiredContainer().images[CONTAINER_IMAGE];
    if (image === undefined) {
      throw new Error(`Container image "${CONTAINER_IMAGE}" is unavailable`);
    }
    return image;
  }

  private terminalRecord(record: ContainersRecord): ContainersRecord {
    const read = readRetirements(record.retirements);
    // A malformed fence set cannot be preserved, but a valid one must survive the
    // identity so a delayed Stop or reserve of a retired nonce is still refused.
    const retirements = read.kind === 'valid' || read.kind === 'saturated' ? read.fences : [];
    return {
      state: 'idle',
      allocationRef: null,
      stopOpId: null,
      ...(record.runtimeProtocolVersion === 1 || record.nativeLaunch !== undefined
        ? { runtimeProtocolVersion: 1 as const }
        : {}),
      lastSnapshot: record.lastSnapshot ?? null,
      ...(record.instance !== undefined ? { instance: record.instance } : {}),
      ...(record.billingConfigured ? { billingConfigured: true } : {}),
      ...(record.egressPolicy === undefined ? {} : { egressPolicy: record.egressPolicy }),
      ...(record.repositoryStartFailures === undefined
        ? {}
        : { repositoryStartFailures: record.repositoryStartFailures }),
      // Retirement fences outlive the identity so a delayed Stop or reserve of a
      // retired nonce is still refused. The native plan itself does not survive.
      ...(retirements.length === 0 ? {} : { retirements }),
      ...(record.lastNativeStop === undefined ? {} : { lastNativeStop: record.lastNativeStop }),
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
    const terminal = this.terminalRecord(current);
    const native = readNativeLaunchRecord(current.nativeLaunch);
    if (native.kind === 'valid') {
      terminal.lastNativeStop = {
        allocationId: native.record.allocationId,
        launchId: native.record.launchId,
        confirmedAt: Date.now(),
      };
    }
    await this.writeRecord(terminal);
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
    const base = await this.captureBaseIdentity(allocationRef);
    if (base === null) return false;
    const startedAt = Date.now();
    try {
      const snapshot = await withTimeout(
        container.snapshotContainer({}),
        REPO_CAPTURE_TIMEOUT_MS,
        'container snapshot timed out'
      );
      const snapshotMs = Date.now() - startedAt;
      const size = Number.isFinite(snapshot.size) ? snapshot.size : undefined;
      // The nonce must be unchanged across the capture: a same-ref replacement
      // must not publish an abandoned capture.
      if (!(await this.captureStillCurrent(allocationRef, base.launchId))) {
        logRepositoryCapture('abandoned', snapshotMs, { size });
        return false;
      }
      const key = await repoSnapshotIndexKey(repoKey, base.image);
      // The capture start bounds the contents' age from above, so an age logged on
      // use never understates how stale the repository is.
      const stored = await index.store(key, {
        snapshotId: snapshot.id,
        capturedAt: startedAt,
        ...(size === undefined ? {} : { size }),
        ...(commit === undefined ? {} : { commit }),
      });
      logRepositoryCapture(stored ? 'stored' : 'index_unavailable', snapshotMs, { size });
      return stored;
    } catch (error) {
      logRepositoryCapture('failed', Date.now() - startedAt, { error });
      return false;
    }
  }

  private async isRunningAllocation(allocationRef: string): Promise<boolean> {
    const record = await this.readRecord();
    return record.state === 'running' && record.allocationRef === allocationRef;
  }

  // --- native runtime launch operations ---------------------------------------

  /**
   * Reserve the persisted native nonce BEFORE slow billing or source preflight.
   * The short queued commit binds the ref, the immutable original base and the
   * effective attempt deadline. A same-nonce reentry returns the same plan
   * without minting a new budget; a retired nonce is refused recoverably.
   */
  async reserveNativeLaunch(input: NativeReserveRequest): Promise<RuntimeReserveResult> {
    // Reservation-before-slow-billing, but driven only by durable state: the ref,
    // the original base and the first reservation are committed before the source
    // lookup, and the identity-change settlement is a recoverable refusal, never
    // a held queue.
    const planned = await this.runExclusive(async () => {
      let record = await this.readRecord();
      const retirements = this.readRetirementsOrRefuse(record);
      if ('reason' in retirements) return { kind: 'refused', reason: retirements.reason } as const;
      const existing = readNativeLaunchRecord(record.nativeLaunch);
      if (existing.kind === 'invalid') {
        return { kind: 'refused', reason: 'metadata_invalid' } as const;
      }
      if (existing.kind === 'valid') {
        if (
          existing.record.launchId === input.launchId &&
          existing.record.allocationId === input.allocationId &&
          record.allocationRef === input.providerRef
        ) {
          if (isRetired(retirements.fences, input.launchId, Date.now()))
            return { kind: 'refused', reason: 'retired' } as const;
          if (existing.record.source.kind === 'resolving')
            return { kind: 'resolve', source: existing.record.source } as const;
          return { kind: 'existing', native: existing.record } as const;
        }
        // A different plan owns this container: refuse recoverably and never
        // overwrite its ref or nonce.
        return { kind: 'refused', reason: 'allocation_owned' } as const;
      }
      const now = Date.now();
      if (retirements.fences.length >= NATIVE_RETIREMENT_CAP)
        return { kind: 'refused', reason: 'retirement_saturated' } as const;
      if (isRetired(retirements.fences, input.launchId, now)) {
        return { kind: 'refused', reason: 'retired' } as const;
      }
      if (
        existing.kind === 'absent' &&
        record.runtimeProtocolVersion === undefined &&
        record.allocationRef !== null
      ) {
        if ((await this.stopRecord(record)) !== 'terminal')
          return { kind: 'unavailable', reason: 'legacy_cleanup_unconfirmed' } as const;
        record = await this.readRecord();
      }
      // Never overwrite another owner, a non-idle phase, or a running container
      // this nonce did not issue.
      if (
        record.state !== 'idle' ||
        record.allocationRef !== null ||
        this.ctx.container?.running === true
      ) {
        return { kind: 'refused', reason: 'allocation_owned' } as const;
      }
      let image: string;
      try {
        image = this.containerImage();
      } catch {
        return { kind: 'refused', reason: 'image_unavailable' } as const;
      }
      // An identity change waits for the old generation through its old persisted
      // identity: billing must not cross from the old size into the new one.
      if (
        record.instance !== undefined &&
        record.instance !== input.instance &&
        record.billingConfigured === true
      ) {
        const settlement = await this.prepareIdentityReplacement(record);
        if (!settlement.ok) return { kind: 'refused', reason: 'billing_settlement' } as const;
      }
      const firstReservationAt = now;
      const source = {
        kind: 'resolving' as const,
        image,
        skipRepository: input.skipRepository === true,
        ...(input.repoKey === undefined ? {} : { repoKey: input.repoKey }),
      };
      const nativeLaunch: NativeLaunchRecord = {
        allocationId: input.allocationId,
        launchId: input.launchId,
        outerDeadlineAt: input.outerDeadlineAt,
        firstReservationAt,
        // The original base binds here, before the off-queue source lookup. The
        // repository budget is the loosest; a miss tightens it and it is never
        // rebased from a later clock.
        attemptDeadlineAt: nativeAttemptDeadlineAt(
          input.repoKey === undefined || input.skipRepository === true ? 'image' : 'repository',
          firstReservationAt,
          input.outerDeadlineAt
        ),
        source,
        ...(input.runtimeIdentity === undefined ? {} : { runtimeIdentity: input.runtimeIdentity }),
        interception: input.containment || input.egressAllowlist !== undefined,
      };
      const allowlist = nativeEgressAllowlistSchema.optional().parse(input.egressAllowlist);
      const next: ContainersRecord = {
        ...record,
        state: 'launching',
        allocationRef: input.providerRef,
        runtimeProtocolVersion: 1,
        stopOpId: null,
        instance: input.instance,
        nativeLaunch,
      };
      // Launch never introduces billing attribution (admission owns that); it only
      // clears a flag the new size can no longer honour.
      if (resolveContainersBillingIdentity(input.instance) === undefined) {
        delete next.billingConfigured;
      }
      if (allowlist === undefined) delete next.egressPolicy;
      else next.egressPolicy = { allocationRef: input.providerRef, allowlist };
      if (retirements.fences.length === 0) delete next.retirements;
      else next.retirements = retirements.fences;
      await this.writeRecord(next);
      return { kind: 'resolve', source } as const;
    });
    if (planned.kind === 'refused' || planned.kind === 'unavailable') return planned;
    if (planned.kind === 'existing') return this.nativeReserveResult(input, planned.native);

    // The KV source lookup runs OFF the operation queue; the committed source is
    // then re-guarded by the token so a Stop during the lookup is refused.
    const decision = await decideStartSource({
      index: this.repoSnapshotIndex(),
      image: planned.source.image,
      repoKey: planned.source.repoKey,
      skipRepository: planned.source.skipRepository,
      allowRepository: true,
      failures: (await this.readRecord()).repositoryStartFailures,
    }).catch(() => null);
    return this.runExclusive(async () => {
      const owned = await this.readOwnedNativePlan(input);
      if (owned.kind === 'refused') return owned;
      const { record, native } = owned;
      // Once bound to a repository snapshot, never re-resolve it.
      if (native.source.kind !== 'resolving') {
        return this.nativeReserveResult(input, native);
      }
      const image = native.source.image;
      const bound: NativeLaunchRecord =
        decision !== null && decision.kind === 'repository'
          ? {
              ...native,
              attemptDeadlineAt: Math.min(
                native.attemptDeadlineAt,
                nativeAttemptDeadlineAt(
                  'repository',
                  native.firstReservationAt,
                  native.outerDeadlineAt
                )
              ),
              source: {
                kind: 'repository',
                image,
                snapshotId: decision.snapshotId,
                indexKey: decision.indexKey,
              },
            }
          : {
              ...native,
              // A miss (or an unavailable index) tightens the bound to the image
              // budget, derived from the first reservation, never rebased.
              attemptDeadlineAt: Math.min(
                native.attemptDeadlineAt,
                nativeAttemptDeadlineAt('image', native.firstReservationAt, native.outerDeadlineAt)
              ),
              source: { kind: 'image', image },
            };
      const next: ContainersRecord = { ...record, nativeLaunch: bound };
      await this.writeRecord(next);
      return this.nativeReserveResult(input, bound);
    });
  }

  private nativeReserveResult(
    input: NativeReserveRequest,
    native: NativeLaunchRecord
  ): RuntimeReserveResult {
    if (native.source.kind === 'resolving')
      return { kind: 'unavailable', reason: 'source_pending' };
    const base = {
      kind: 'reserved' as const,
      providerRef: input.providerRef,
      startSource: native.source.kind,
      attemptDeadlineAt: native.attemptDeadlineAt,
    };
    if (native.settled !== undefined) {
      return { ...base, phase: 'settled', outcome: native.settled.result };
    }
    if (native.start !== undefined) return { ...base, phase: 'issued', start: native.start };
    if (native.issuedAt !== undefined) {
      // An issuance fence with no recorded decision: reconcile, never reissue.
      return { ...base, phase: 'issued', start: { kind: 'unknown', reason: 'issued' } };
    }
    return { ...base, phase: 'reserved' };
  }

  /**
   * Start the supplied shared command as PID 1 exactly once. Issuance is
   * persisted before the synchronous `container.start`, so an ambiguous
   * acknowledgement reconciles by observation and never repeats the start. A
   * retired or stale token is refused without any physical work.
   */
  async startNativeLaunch(input: NativeStartRequest): Promise<RuntimeStartResult> {
    const pre = await this.readRecord();
    const preflight = this.nativeStartPreflight(pre, input);
    if (preflight !== undefined) return preflight;
    return this.runExclusive(async () => {
      const owned = await this.readOwnedNativePlan(input);
      if (owned.kind === 'refused') return owned;
      const { record, native } = owned;
      // A recorded mechanical decision is replayed, never reissued.
      if (native.source.kind === 'resolving') return { kind: 'refused', reason: 'source_pending' };
      if (native.start !== undefined) return native.start;
      if (native.issuedAt !== undefined) return { kind: 'unknown', reason: 'issued' };
      const container = this.requiredContainer();
      if (native.interception) {
        await this.installOutboundProxy(container, record.egressPolicy?.allowlist);
      }
      // Recheck the bound AFTER any queue wait or interception await, immediately
      // before issuance: an aged-out attempt does zero physical work.
      if (Date.now() >= native.attemptDeadlineAt) {
        const start: RuntimeStartResult = { kind: 'unknown', reason: 'deadline' };
        await this.writeRecord({ ...record, nativeLaunch: { ...native, start } });
        return start;
      }
      // Never claim a container this nonce did not issue: an unexplained running
      // container is someone else's process, not our issuance.
      if (container.running === true) {
        const start: RuntimeStartResult = { kind: 'refused', reason: 'container_running' };
        await this.writeRecord({ ...record, nativeLaunch: { ...native, start } });
        return start;
      }
      const issuedNative: NativeLaunchRecord = { ...native, issuedAt: Date.now() };
      const issuedRecord: ContainersRecord = { ...record, nativeLaunch: issuedNative };
      await this.writeRecord(issuedRecord);
      const options = this.nativeStartOptions(record, native, input);
      try {
        await this.startContainerAndActivateBilling(container, record, options);
      } catch (error) {
        if (this.containerRunningNow()) {
          // The start took effect before the error: an ambiguous issuance, not a
          // rejection. Keep the issuance fence; never penalise a snapshot here.
          const start: RuntimeStartResult = { kind: 'unknown', reason: 'start_ambiguous' };
          await this.writeRecord({ ...issuedRecord, nativeLaunch: { ...issuedNative, start } });
          return start;
        }
        // A confirmed physical rejection (the container is not running). The
        // mechanical outcome and the issuance fence are recorded so a retry can
        // never reissue it; only a repository snapshot is penalised.
        const start: RuntimeStartResult =
          native.source.kind === 'repository'
            ? { kind: 'snapshot-failed' }
            : { kind: 'unknown', reason: 'start_rejected' };
        await this.markNativeStartRejected(native, start, error);
        return start;
      }
      await this.writeRunning(input.providerRef, 'clear');
      const start: RuntimeStartResult = { kind: 'issued' };
      await this.recordNativeStartResult(input.providerRef, start);
      // F2: install the provider lease best-effort after confirmed issuance, so
      // the container is not reaped before the wrapper reports ready.
      await this.ensureNativeLaunchLease(input.providerRef);
      return start;
    });
  }

  /** The pre-queue fast path: replay or refusal that needs no operation queue. */
  private nativeStartPreflight(
    record: ContainersRecord,
    input: NativeStartRequest
  ): RuntimeStartResult | undefined {
    const nativeRead = readNativeLaunchRecord(record.nativeLaunch);
    if (nativeRead.kind === 'invalid') return { kind: 'refused', reason: 'metadata_invalid' };
    if (
      nativeRead.kind !== 'valid' ||
      nativeRead.record.launchId !== input.launchId ||
      record.allocationRef !== input.providerRef
    ) {
      return { kind: 'refused', reason: 'stale_token' };
    }
    if (nativeRead.record.start !== undefined) return nativeRead.record.start;
    const retirements = this.readRetirementsOrRefuse(record);
    if ('reason' in retirements) return { kind: 'refused', reason: retirements.reason };
    if (isRetired(retirements.fences, input.launchId, Date.now())) {
      return { kind: 'refused', reason: 'retired' };
    }
    if (nativeRead.record.issuedAt !== undefined) return { kind: 'unknown', reason: 'issued' };
    return undefined;
  }

  private async recordNativeStartResult(
    providerRef: string,
    start: RuntimeStartResult
  ): Promise<void> {
    const record = await this.readRecord();
    const native = readNativeLaunchRecord(record.nativeLaunch);
    if (native.kind !== 'valid' || record.allocationRef !== providerRef) return;
    await this.writeRecord({ ...record, nativeLaunch: { ...native.record, start } });
  }

  /** Best-effort provider lease after a confirmed native issuance. */
  private async ensureNativeLaunchLease(providerRef: string): Promise<void> {
    try {
      await this.ensureLeaseAtLeast(providerRef, leaseAtLeastMs());
    } catch (error) {
      logControlDiagnostic(
        'lease_renewal_failed',
        {
          allocationRef: providerRef,
          stage: 'native_launch',
          errorName: error instanceof Error ? diagnosticCause(error.name) : 'unknown',
        },
        'warn'
      );
    }
  }

  /**
   * Observe an existing running container only. A stopped container is never
   * woken; the reads are bounded and the token is re-checked after every await so
   * a delayed read cannot report for a replacement.
   */
  async observeNativeLaunch(input: NativeObserveRequest): Promise<RuntimeLaunchObservation> {
    const guard = await this.nativeObservationGuard(input);
    if (guard !== 'ok') return this.nativeLostObservation(guard);
    const container = this.ctx.container;
    if (!container) return { process: 'unknown' };
    if (container.running !== true) return { process: 'terminal' };
    const receipt = await this.readNativeReceipt(input);
    // Re-guard immediately before the PID 1 exec: a Stop must not wake or observe
    // a stopped or replaced container.
    const beforeProcess = await this.nativeObservationGuard(input);
    if (beforeProcess !== 'ok') return this.nativeLostObservation(beforeProcess);
    if (container.running !== true) return { process: 'terminal' };
    const process = await this.observeNativeProcess(input);
    const after = await this.nativeObservationGuard(input);
    if (after !== 'ok') return this.nativeLostObservation(after);
    return { ...(receipt === null ? {} : { receipt }), process };
  }

  private nativeLostObservation(guard: 'retired' | 'lost'): RuntimeLaunchObservation {
    // A retired or replaced launch owns nothing: end observation at once as
    // ownership-lost rather than poll to the bound.
    return guard === 'retired' ? { retired: true, process: 'unknown' } : { process: 'unknown' };
  }

  private async nativeObservationGuard(
    input: NativeObserveRequest
  ): Promise<'ok' | 'retired' | 'lost'> {
    const record = await this.readRecord();
    const retirements = readRetirements(record.retirements);
    if (retirements.kind === 'invalid' || retirements.kind === 'saturated') return 'lost';
    const fences = retirements.kind === 'valid' ? retirements.fences : [];
    const nativeRead = readNativeLaunchRecord(record.nativeLaunch);
    if (nativeRead.kind === 'invalid') return 'lost';
    const owns =
      nativeRead.kind === 'valid' &&
      nativeRead.record.launchId === input.launchId &&
      record.allocationRef === input.providerRef;
    if (!owns) return isRetired(fences, input.launchId, Date.now()) ? 'retired' : 'lost';
    if (isRetired(fences, input.launchId, Date.now())) return 'retired';
    return 'ok';
  }

  /** Persist the common-classified outcome under the live token. False means stale. */
  async settleNativeLaunch(input: NativeSettleRequest): Promise<boolean> {
    return this.runExclusive(async () => {
      const record = await this.readRecord();
      const nativeRead = readNativeLaunchRecord(record.nativeLaunch);
      if (nativeRead.kind !== 'valid' || nativeRead.record.launchId !== input.launchId) {
        return false;
      }
      const retirements = readRetirements(record.retirements);
      if (retirements.kind === 'invalid' || retirements.kind === 'saturated') return false;
      if (
        isRetired(
          retirements.kind === 'valid' ? retirements.fences : [],
          input.launchId,
          Date.now()
        )
      ) {
        return false;
      }
      // No expiry veto: a truthful outcome (including an exact-deadline result)
      // must settle while the identity is still current and unretired. Expiry
      // blocks new physical work, not settlement.
      const settled: NativeLaunchSettlement = { result: input.result, at: Date.now() };
      await this.writeRecord({
        ...record,
        nativeLaunch: { ...nativeRead.record, settled },
      });
      return true;
    });
  }

  /**
   * Delete the exact retained receipt as acknowledgement. Only a durably settled
   * current token may be acknowledged, and an acknowledgement failure is not an
   * outcome failure.
   */
  async acknowledgeNativeLaunch(input: NativeAckRequest): Promise<void> {
    // Never acknowledge without an observed current receipt.
    const receipt = input.receipt;
    if (receipt === undefined) return;
    // Short queued token check, then the physical delete waits off-queue so a
    // long exec cannot hold Stop.
    const issued = await this.runExclusive(async () => {
      const record = await this.readRecord();
      const nativeRead = readNativeLaunchRecord(record.nativeLaunch);
      if (nativeRead.kind !== 'valid' || nativeRead.record.launchId !== input.launchId) return null;
      if (nativeRead.record.settled === undefined || nativeRead.record.acked === true) return null;
      const retirements = readRetirements(record.retirements);
      if (retirements.kind === 'invalid' || retirements.kind === 'saturated') return null;
      if (
        isRetired(
          retirements.kind === 'valid' ? retirements.fences : [],
          input.launchId,
          Date.now()
        )
      ) {
        return null;
      }
      const live = this.ctx.container;
      if (!live || live.running !== true) return null;
      return {
        pending: live.exec(nativeReceiptDeleteCommand(input.launchId, receipt)),
        providerRef: record.allocationRef,
      };
    });
    if (issued === null) return;
    let exitCode = 1;
    try {
      const proc = await withTimeout(
        issued.pending,
        CONTAINER_CALL_TIMEOUT_MS,
        'receipt acknowledgement timed out'
      );
      const output = await withTimeout(
        proc.output(),
        CONTAINER_CALL_TIMEOUT_MS,
        'receipt acknowledgement timed out'
      );
      exitCode = output.exitCode;
    } catch {
      // A failed delete leaves the outcome durable and the ACK retryable.
      return;
    }
    // Only a confirmed deletion (exit 0) marks the ACK complete; an absence (1),
    // a receipt mismatch (2), or a hostile path (3) does not.
    if (exitCode !== 0) return;
    await this.runExclusive(async () => {
      if (
        issued.providerRef === null ||
        (await this.nativeObservationGuard({
          providerRef: issued.providerRef,
          launchId: input.launchId,
          deadlineAt: Infinity,
        })) !== 'ok'
      )
        return;
      const current = await this.readRecord();
      const currentNative = readNativeLaunchRecord(current.nativeLaunch);
      if (currentNative.kind !== 'valid' || currentNative.record.launchId !== input.launchId)
        return;
      if (currentNative.record.settled === undefined) return;
      await this.writeRecord({
        ...current,
        nativeLaunch: { ...currentNative.record, acked: true },
      });
    });
  }

  /**
   * Confirmed destruction for a fallback or admission failure. The retire fence
   * is persisted BEFORE destruction so a delayed reserve of the same nonce is
   * refused. Saturation is refused recoverably.
   */
  async destroyNativeLaunch(input: NativeDestroyRequest): Promise<boolean> {
    return this.runExclusive(async () => {
      const record = await this.readRecord();
      const nativeRead = readNativeLaunchRecord(record.nativeLaunch);
      if (nativeRead.kind === 'invalid') return false;
      if (nativeRead.kind !== 'valid' || nativeRead.record.launchId !== input.launchId)
        return false;
      if ((await this.retireNativeToken(record, input.launchId, input.outerDeadlineAt)) === null) {
        return false;
      }
      return (await this.stopRecord(await this.readRecord())) === 'terminal';
    });
  }

  /**
   * Retire and clean a reservation whose admission failed, with no physical
   * start. No clearing without a confirmed fence: a saturated retirement leaves
   * the reservation intact rather than clearing it unfenced.
   */
  async retireNativeLaunch(input: NativeRetireRequest): Promise<void> {
    const needsStop = await this.runExclusive(async () => {
      const record = await this.readRecord();
      const nativeRead = readNativeLaunchRecord(record.nativeLaunch);
      if (nativeRead.kind !== 'valid' || nativeRead.record.launchId !== input.launchId)
        return false;
      if (record.allocationRef !== input.providerRef) return false;
      if (
        nativeRead.record.issuedAt !== undefined ||
        nativeRead.record.start !== undefined ||
        this.ctx.container?.running === true
      )
        return true;
      if ((await this.retireNativeToken(record, input.launchId, input.outerDeadlineAt)) === null) {
        return false;
      }
      const current = await this.readRecord();
      if (current.allocationRef !== input.providerRef) return false;
      const cleared: ContainersRecord = {
        ...current,
        allocationRef: null,
        state: 'idle',
        stopOpId: null,
      };
      delete cleared.nativeLaunch;
      await this.writeRecord(cleared);
      return false;
    });
    if (
      needsStop &&
      (await this.stop(input.providerRef, {
        launchId: input.launchId,
        createDeadlineAt: input.outerDeadlineAt,
      })) !== 'terminal'
    )
      throw new Error('Native launch retirement cleanup is unconfirmed');
  }

  /** Bounded non-secret operator evidence for the accepted native operation. */
  async nativeLaunchEvidence(): Promise<NativeLaunchEvidence> {
    const record = await this.readRecord();
    const nativeRead = readNativeLaunchRecord(record.nativeLaunch);
    return nativeLaunchEvidence(
      this.ctx.id.toString(),
      nativeRead.kind === 'valid' ? nativeRead.record : undefined,
      record.lastNativeStop
    );
  }

  private nativeStartOptions(
    record: ContainersRecord,
    native: NativeLaunchRecord,
    input: NativeStartRequest
  ): ContainerStartupOptions {
    return {
      ...(native.source.kind !== 'repository'
        ? { image: native.source.image }
        : { containerSnapshot: { id: native.source.snapshotId } }),
      instance: record.instance ?? CLOUDFLARE_CONTAINERS_DEFAULT_INSTANCE,
      enableInternet: record.egressPolicy === undefined,
      // The shared command is the initial process: /bin/sh -c <command>.
      entrypoint: ['/bin/sh', '-c', input.command],
      env: this.nativeLaunchEnv(withoutArtifactEnv(input.env), native.interception),
      labels: nativeLaunchLabels(native.launchId),
    };
  }

  /**
   * Record a confirmed physical start rejection: the mechanical outcome and the
   * issuance fence are durable, so a retry replays the rejection and never
   * reissues. Only a repository snapshot start is penalised.
   */
  private async markNativeStartRejected(
    native: NativeLaunchRecord,
    start: RuntimeStartResult,
    error: unknown
  ): Promise<void> {
    const record = await this.readRecord();
    const current = readNativeLaunchRecord(record.nativeLaunch);
    if (current.kind !== 'valid' || current.record.launchId !== native.launchId) return;
    const rejected: NativeLaunchRecord = { ...current.record, start };
    // Nothing was issued: drop the issuance fence but keep the mechanical result.
    delete rejected.issuedAt;
    const next: ContainersRecord = {
      ...record,
      nativeLaunch: rejected,
    };
    if (native.source.kind === 'repository') {
      const previous = record.repositoryStartFailures;
      const attempts =
        (previous?.snapshotId === native.source.snapshotId ? previous.attempts : 0) + 1;
      next.repositoryStartFailures = { snapshotId: native.source.snapshotId, attempts };
      logControlDiagnostic('snapshot_start_failed', {
        sandboxId: this.sandboxNameForLog(),
        reason: 'repository_start_failed',
        attempts,
        errorName: error instanceof Error ? diagnosticCause(error.name) : 'unknown',
        cause: error instanceof Error ? diagnosticCause(error.message) : 'unknown',
      });
    }
    await this.writeRecord(next);
  }

  private async issueNativeProbe(
    input: NativeObserveRequest,
    command: string[]
  ): Promise<ExecProcess | null> {
    const issued = await this.runExclusive(async () => {
      if ((await this.nativeObservationGuard(input)) !== 'ok' || Date.now() >= input.deadlineAt)
        return null;
      const container = this.ctx.container;
      if (!container || container.running !== true) return null;
      return { pending: container.exec(command) };
    });
    return issued === null
      ? null
      : this.awaitContainerCall(issued.pending, this.boundedObservationDeadline(input.deadlineAt));
  }

  private async readNativeReceipt(input: NativeObserveRequest): Promise<string | null> {
    try {
      const proc = await this.issueNativeProbe(input, nativeReceiptReadCommand(input.launchId));
      if (proc === null) return null;
      const output = await this.awaitContainerCall(
        proc.output(),
        this.boundedObservationDeadline(input.deadlineAt)
      );
      if (output.exitCode !== 0) return null;
      return new TextDecoder().decode(output.stdout);
    } catch {
      return null;
    }
  }

  private async observeNativeProcess(
    input: NativeObserveRequest
  ): Promise<RuntimeLaunchProcessObservation> {
    try {
      const process = await this.issueNativeProbe(input, ['cat', '/proc/1/cmdline']);
      if (process === null) return 'unknown';
      const output = await this.awaitContainerCall(
        process.output(),
        this.boundedObservationDeadline(input.deadlineAt)
      );
      return output.exitCode === 0
        ? nativeProcessObservation(new Uint8Array(output.stdout))
        : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /** Keep one native read under a short bound, never longer than the attempt deadline. */
  private boundedObservationDeadline(deadlineAt: number): number {
    return Math.min(deadlineAt, Date.now() + CONTAINER_CALL_TIMEOUT_MS);
  }

  /**
   * Strictly read the persisted retirement fences. A malformed set is refused as
   * metadata-invalid; a well-formed over-cap set is refused as saturated. Neither
   * is silently truncated or downgraded.
   */
  private readRetirementsOrRefuse(
    record: ContainersRecord
  ): { fences: NativeRetirementFence[] } | { reason: 'metadata_invalid' | 'retirement_saturated' } {
    const read = readRetirements(record.retirements);
    if (read.kind === 'invalid') return { reason: 'metadata_invalid' };
    if (read.kind === 'saturated') return { reason: 'retirement_saturated' };
    return { fences: read.kind === 'valid' ? read.fences : [] };
  }

  /**
   * Read the native plan a token currently owns, failing closed on malformed
   * evidence and refusing a stale, retired, or replaced nonce. Shared by the
   * reserve source-commit and the queued start so ownership is decided once.
   */
  private async readOwnedNativePlan(input: {
    launchId: string;
    providerRef: string;
  }): Promise<
    | { kind: 'ok'; record: ContainersRecord; native: NativeLaunchRecord }
    | { kind: 'refused'; reason: string }
  > {
    const record = await this.readRecord();
    const retirements = this.readRetirementsOrRefuse(record);
    if ('reason' in retirements) return { kind: 'refused', reason: retirements.reason };
    const nativeRead = readNativeLaunchRecord(record.nativeLaunch);
    if (nativeRead.kind === 'invalid') return { kind: 'refused', reason: 'metadata_invalid' };
    if (
      nativeRead.kind !== 'valid' ||
      nativeRead.record.launchId !== input.launchId ||
      record.allocationRef !== input.providerRef
    ) {
      return { kind: 'refused', reason: 'stale_token' };
    }
    if (isRetired(retirements.fences, input.launchId, Date.now())) {
      return { kind: 'refused', reason: 'retired' };
    }
    return { kind: 'ok', record, native: nativeRead.record };
  }

  /** Record a retirement fence. Null means saturation: refuse without discarding fences. */
  private async retireNativeToken(
    record: ContainersRecord,
    launchId: string,
    outerDeadlineAt: number
  ): Promise<NativeRetirementFence[] | null> {
    const read = readRetirements(record.retirements);
    if (read.kind === 'invalid' || read.kind === 'saturated') return null;
    const fences = read.kind === 'valid' ? read.fences : [];
    let result: ReturnType<typeof recordRetirement>;
    try {
      result = recordRetirement(
        pruneRetirements(fences, Date.now()),
        launchId,
        outerDeadlineAt,
        Date.now()
      );
    } catch {
      return null;
    }
    if (result.kind === 'saturated') return null;
    await this.writeRecord({ ...record, retirements: result.fences });
    return result.fences;
  }

  private launchTokenForRecord(record: ContainersRecord): NativeLaunchToken | undefined {
    const read = readNativeLaunchRecord(record.nativeLaunch);
    if (read.kind !== 'valid') return undefined;
    return { launchId: read.record.launchId, createDeadlineAt: read.record.outerDeadlineAt };
  }

  /**
   * The base identity a capture is labelled with. A native plan proves it only
   * when the running container's inspect corroborates this launch's nonce; a
   * missing, mismatched, or unavailable inspect declines the capture. A legacy
   * record is labelled only from the running container's inspected image, never
   * today's `images.app`, which a redeploy may have changed.
   */
  private async captureBaseIdentity(
    allocationRef: string
  ): Promise<{ image: string; launchId: string | null } | null> {
    const record = await this.readRecord();
    const nativeRead = readNativeLaunchRecord(record.nativeLaunch);
    if (nativeRead.kind === 'invalid') return null;
    if (nativeRead.kind === 'valid' && record.allocationRef === allocationRef) {
      const native = nativeRead.record;
      let labelled: string | undefined;
      try {
        const info = await this.requiredContainer().inspect();
        labelled = info?.labels?.[NATIVE_LAUNCH_LABEL];
      } catch {
        // An unavailable inspect is not proof of this launch's base: decline.
        return null;
      }
      if (labelled !== native.launchId) return null;
      return { image: native.source.image, launchId: native.launchId };
    }
    try {
      const info = await this.requiredContainer().inspect();
      if (info !== null && typeof info.image === 'string' && info.image !== '') {
        return { image: info.image, launchId: null };
      }
    } catch {
      // Decline: an unproven identity must not publish a capture.
    }
    return null;
  }

  /**
   * True while the captured base still describes the current running allocation.
   * For a native plan the nonce must be unchanged, so a same-ref replacement
   * cannot publish an abandoned capture.
   */
  private async captureStillCurrent(
    allocationRef: string,
    launchId: string | null
  ): Promise<boolean> {
    const record = await this.readRecord();
    if (record.state !== 'running' || record.allocationRef !== allocationRef) return false;
    if (launchId === null) return true;
    const nativeRead = readNativeLaunchRecord(record.nativeLaunch);
    return nativeRead.kind === 'valid' && nativeRead.record.launchId === launchId;
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
    await this.stop(record.allocationRef, this.launchTokenForRecord(record));
  }

  private async destroyBillingContainer(): Promise<void> {
    const record = await this.readRecord();
    if (record.allocationRef === null) return;
    if (
      (await this.stop(record.allocationRef, this.launchTokenForRecord(record))) === 'retryable'
    ) {
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
    const record = (await this.ctx.storage.get<ContainersRecord>(RECORD_KEY)) ?? IDLE_RECORD;
    nativeRuntimeProtocolSchema.parse(record.runtimeProtocolVersion);
    return record;
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
