import { getBillingContext } from '@kilocode/container-usage';
import { withTimeout } from '@kilocode/worker-utils';
import { DurableObject } from 'cloudflare:workers';
import { billingHeartbeatSeconds } from '../container-usage.js';
import {
  CONTROL_WRAPPER_LOG_PATH,
  CONTROL_WRAPPER_PATH,
} from '../sandbox-control/container-paths.js';
import { selectStartSnapshot } from '../sandbox-control/warm-base.js';
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
  warmSnapshotId?: string;
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

type ContainersRecord = {
  state: ContainersState;
  allocationRef: string | null;
  stopOpId: string | null;
  lastSnapshot: { id: string; sourceAllocation: string } | null;
  instance?: ContainerInstanceSize;
  billingConfigured?: true;
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
const PROBE_TIMEOUT_MS = 5_000;
const CONTAINER_CALL_TIMEOUT_MS = 5_000;
const WRAPPER_EXEC_TIMEOUT_MS = 60_000;
const SNAPSHOT_TIMEOUT_MS = 10_000;
const DESTROY_TIMEOUT_MS = 30_000;
const MAX_LOG_BYTES = 1024 * 1024;

const IDLE_RECORD: ContainersRecord = {
  state: 'idle',
  allocationRef: null,
  stopOpId: null,
  lastSnapshot: null,
};

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
      // Persist the accepted physical instance before any early return or physical
      // operation, so a resumed launch whose exec fails still records its size.
      const record = await this.installLaunchInstance(stored, input.instance);
      if (record.state === 'running' && record.allocationRef === ref) {
        return { started: false };
      }
      if (record.state === 'launching' && record.allocationRef === ref) {
        return this.resumeLaunch(record, ref, input.env, input.instance, input.warmSnapshotId);
      }
      const container = this.requiredContainer();
      // Ownership is retained before start: an ambiguous start that takes effect must not release the allocation.
      await this.writeRecord({ ...record, state: 'launching', allocationRef: ref, stopOpId: null });
      await this.startContainerAndActivateBilling(
        container,
        record,
        this.startOptions(
          input.instance,
          selectStartSnapshot(record.lastSnapshot?.id, input.warmSnapshotId)
        )
      );
      await this.execWrapper(container, input.env);
      await this.writeRecord({
        ...record,
        state: 'running',
        allocationRef: ref,
        stopOpId: null,
      });
      return { started: true };
    });
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

  async warmBaseFacts(): Promise<{
    image: string;
    sessionSnapshotId: string | null;
    hasRecord: boolean;
  }> {
    const record = await this.ctx.storage.get<ContainersRecord>(RECORD_KEY);
    return {
      image: this.containerImage(),
      sessionSnapshotId: record?.lastSnapshot?.id ?? null,
      hasRecord: record !== undefined,
    };
  }

  async captureWarmBase(): Promise<{ id: string }> {
    return this.runExclusive(async () => {
      const container = this.requiredContainer();
      const snapshot = await withTimeout(
        container.snapshotContainer({}),
        SNAPSHOT_TIMEOUT_MS,
        'container snapshot timed out'
      );
      return { id: snapshot.id };
    });
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

  private async resumeLaunch(
    record: ContainersRecord,
    ref: string,
    env: Record<string, string>,
    instance: ContainerInstanceSize,
    warmSnapshotId: string | undefined
  ): Promise<{ started: boolean }> {
    const container = this.requiredContainer();
    const probe = await this.probeWrapper(container);
    if (probe === 'ambiguous') {
      // A wrapper probe cannot confirm the running container, so activate before
      // signalling the ambiguity rather than leaving it unmetered.
      await this.activateBillingIfRunning(container, record);
      throw new Error('Wrapper probe was ambiguous');
    }
    if (probe === 'absent') {
      // A prior launch may have recorded `launching` before `start()` took
      // effect. Apply the requested instance and snapshot before re-execing the
      // wrapper, otherwise the retry silently runs at the default size.
      await this.startContainerAndActivateBilling(
        container,
        record,
        this.startOptions(
          instance,
          selectStartSnapshot(record.lastSnapshot?.id, warmSnapshotId)
        )
      );
      await this.execWrapper(container, env);
    } else {
      await this.activateBillingIfRunning(container, record);
    }
    await this.writeRecord({ ...record, state: 'running', allocationRef: ref, stopOpId: null });
    return { started: true };
  }

  private async probeWrapper(container: Container): Promise<'found' | 'absent' | 'ambiguous'> {
    try {
      const proc = await withTimeout(
        container.exec(['pgrep', '-f', CONTROL_WRAPPER_PATH]),
        PROBE_TIMEOUT_MS,
        'wrapper probe timed out'
      );
      const exitCode = await withTimeout(
        proc.exitCode,
        PROBE_TIMEOUT_MS,
        'wrapper probe timed out'
      );
      if (exitCode === 0) return 'found';
      if (exitCode === 1) return 'absent';
      return 'ambiguous';
    } catch {
      return 'ambiguous';
    }
  }

  private async execWrapper(container: Container, env: Record<string, string>): Promise<void> {
    await withTimeout(
      container.exec(['bun', 'run', CONTROL_WRAPPER_PATH], { env, cwd: '/' }),
      WRAPPER_EXEC_TIMEOUT_MS,
      'wrapper exec timed out'
    );
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
      await this.writeRecord(this.terminalRecord(record));
      await this.settleBillingAtStop(record);
      return 'terminal';
    }
    await this.snapshotBeforeDestroy(container, ref, stopOpId);
    try {
      await withTimeout(container.destroy(), DESTROY_TIMEOUT_MS, 'container destroy timed out');
    } catch {
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
}
