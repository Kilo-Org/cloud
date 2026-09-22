import {
  createContainerUsageClient,
  getBillingContext,
  installBillingHeartbeat,
  type BillingContextStorage,
  type BillingHeartbeatController,
  type ContainerUsageRpcMethods,
} from '@kilocode/container-usage';
import { CLOUDFLARE_CONTAINERS_INSTANCES } from '@kilocode/worker-utils/sandbox-allocation';
import { logger } from '../logger.js';
import {
  containersBillingIdentity,
  parseSandboxBillingInput,
  type ContainersBillingIdentity,
  type SandboxBillingAdmissionResult,
} from '../container-usage-context.js';
import {
  MeteredBillingLifecycle,
  type BillingIdentity,
  type ContainerStopParams,
} from '../metered-billing-lifecycle.js';
import type { ContainerInstanceSize } from './SandboxContainers.js';

export const BILLING_SCHEDULES_STORAGE_KEY = 'containers:billing-schedules:v1';

type BillingContainer = Parameters<typeof installBillingHeartbeat>[0];

export type ContainersBillingHost = {
  container: BillingContainer;
  storage: BillingContextStorage;
  meter: ContainerUsageRpcMethods;
  heartbeatSeconds: number;
  isContainerRunning: () => boolean;
  stopContainer: () => Promise<void>;
  destroyContainer: () => Promise<void>;
  durableObjectId: string;
  waitUntil: (promise: Promise<unknown>) => void;
};

/**
 * The billing identity owner uses a fixed per-SKU service. Any size it does not
 * map is "not billable" rather than a fallback to the default SKU.
 */
export function resolveContainersBillingIdentity(
  instance: ContainerInstanceSize | undefined
): ContainersBillingIdentity | undefined {
  if (instance === undefined) return undefined;
  if (!(CLOUDFLARE_CONTAINERS_INSTANCES as readonly ContainerInstanceSize[]).includes(instance)) {
    return undefined;
  }
  return containersBillingIdentity(instance);
}

export function unavailableContainersBillingAdmission(
  input: unknown
): SandboxBillingAdmissionResult {
  const parsed = parseSandboxBillingInput(input);
  if (!parsed.enforcementRequested) return { success: true };
  return {
    success: false,
    code: 'meter_unavailable',
    message: 'Container billing is not configured for this instance size',
  };
}

type BillingScheduleEntry = { dueAtMs: number; payload?: unknown };
type BillingScheduleTable = Record<string, BillingScheduleEntry>;

export type DueBillingSchedule = { callback: string; dueAtMs: number; payload?: unknown };

export type BillingScheduleStorage = {
  get: <T = unknown>(key: string) => Promise<T | undefined>;
  put: (key: string, value: unknown) => Promise<void>;
};

export type ContainersBillingSchedulerDeps = {
  storage: BillingScheduleStorage;
  setAlarm: (scheduledTime: number) => Promise<void>;
  deleteAlarm: () => Promise<void>;
  waitUntil: (promise: Promise<unknown>) => void;
  now?: () => number;
};

function earliestDueAtMs(table: BillingScheduleTable): number | undefined {
  let earliest: number | undefined;
  for (const entry of Object.values(table)) {
    if (earliest === undefined || entry.dueAtMs < earliest) earliest = entry.dueAtMs;
  }
  return earliest;
}

function dueEntriesAt(table: BillingScheduleTable, nowMs: number): DueBillingSchedule[] {
  const due: DueBillingSchedule[] = [];
  for (const [callback, entry] of Object.entries(table)) {
    if (entry.dueAtMs <= nowMs) {
      due.push(
        entry.payload === undefined
          ? { callback, dueAtMs: entry.dueAtMs }
          : { callback, dueAtMs: entry.dueAtMs, payload: entry.payload }
      );
    }
  }
  return due;
}

/**
 * Durable, per-callback schedule table. Storage is the source of truth so a
 * cancellation or a dispatched entry survives eviction; the in-memory copy is
 * updated synchronously so a cancelled callback is never eligible for dispatch
 * even before its durable removal completes.
 */
export class ContainersBillingScheduler {
  private table: BillingScheduleTable | undefined;
  private readonly pendingRemovals = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly deps: ContainersBillingSchedulerDeps) {
    this.now = deps.now ?? Date.now;
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async load(): Promise<BillingScheduleTable> {
    if (this.table === undefined) {
      const stored =
        (await this.deps.storage.get<BillingScheduleTable>(BILLING_SCHEDULES_STORAGE_KEY)) ?? {};
      for (const callback of this.pendingRemovals) delete stored[callback];
      this.pendingRemovals.clear();
      this.table = stored;
    }
    return this.table;
  }

  private async persist(table: BillingScheduleTable): Promise<void> {
    this.table = table;
    await this.deps.storage.put(BILLING_SCHEDULES_STORAGE_KEY, table);
    const nextDueAtMs = earliestDueAtMs(table);
    if (nextDueAtMs === undefined) {
      await this.deps.deleteAlarm();
    } else {
      await this.deps.setAlarm(nextDueAtMs);
    }
  }

  async schedule(delaySeconds: number, callback: string, payload?: unknown): Promise<number> {
    return this.run(async () => {
      const table = await this.load();
      const dueAtMs = this.now() + Math.max(0, delaySeconds) * 1_000;
      const next: BillingScheduleTable = { ...table };
      next[callback] = payload === undefined ? { dueAtMs } : { dueAtMs, payload };
      await this.persist(next);
      return dueAtMs;
    });
  }

  deleteSchedules(callback: string): void {
    this.removeFromMemory(callback);
    this.deps.waitUntil(
      this.run(async () => {
        const table = await this.load();
        if (!(callback in table)) {
          await this.persist(table);
          return;
        }
        const next: BillingScheduleTable = { ...table };
        delete next[callback];
        await this.persist(next);
      }).catch(error => {
        logger
          .withFields({
            callback,
            error: error instanceof Error ? error.message : String(error),
          })
          .warn('Container billing schedule cancellation failed');
      })
    );
  }

  private removeFromMemory(callback: string): void {
    if (this.table === undefined) {
      this.pendingRemovals.add(callback);
      return;
    }
    if (!(callback in this.table)) return;
    const next: BillingScheduleTable = { ...this.table };
    delete next[callback];
    this.table = next;
  }

  /**
   * Due schedules without removing them. An entry stays durable until its
   * dispatch completes, so a failure in the dispatch window cannot lose the
   * only heartbeat or force-stop continuation.
   */
  async dueSchedules(): Promise<DueBillingSchedule[]> {
    if (this.table !== undefined) return dueEntriesAt(this.table, this.now());
    return this.run(async () => dueEntriesAt(await this.load(), this.now()));
  }

  /**
   * Remove a claimed entry, but only when its callback did not replace it with a
   * newer schedule. A replaced entry has a different due time or payload, so a
   * stale redelivery cannot delete the continuation the callback just armed.
   */
  async completeDue(claimed: DueBillingSchedule): Promise<void> {
    return this.run(async () => {
      const table = await this.load();
      const current = table[claimed.callback];
      if (current === undefined) return;
      if (current.dueAtMs !== claimed.dueAtMs) return;
      if (current.payload !== claimed.payload) return;
      const next: BillingScheduleTable = { ...table };
      delete next[claimed.callback];
      await this.persist(next);
    });
  }
}

export class ContainersBilling {
  readonly identity: ContainersBillingIdentity;
  private readonly lifecycle: MeteredBillingLifecycle;
  private readonly heartbeat: BillingHeartbeatController;
  private readonly host: ContainersBillingHost;

  constructor(identity: ContainersBillingIdentity, host: ContainersBillingHost) {
    this.identity = identity;
    this.host = host;
    const usageClient = createContainerUsageClient(host.meter, { service: identity.service });
    this.lifecycle = new MeteredBillingLifecycle({
      storage: host.storage,
      usageClient,
      schedule: async (delaySeconds, callback, payload) => {
        await host.container.schedule(delaySeconds, callback, payload);
      },
      deleteSchedules: callback => host.container.deleteSchedules(callback),
      getState: () => this.observedState(),
      isContainerRunning: host.isContainerRunning,
      stopContainer: host.stopContainer,
      destroyContainer: host.destroyContainer,
      durableObjectId: host.durableObjectId,
      waitUntil: host.waitUntil,
    });
    this.heartbeat = installBillingHeartbeat(host.container, {
      client: usageClient,
      storage: host.storage,
      heartbeatSeconds: host.heartbeatSeconds,
      stopOnStoppedState: false,
      deferBudgetStopFinalSettlement: true,
      beforeHeartbeatDelivery: context => this.lifecycle.ensureStartAcknowledged(context),
      beforeStopDelivery: context => this.lifecycle.ensureStartAcknowledged(context),
      onGenerationClosed: (context, cause) =>
        this.lifecycle.onGenerationClosed(this.billingIdentity, context, cause),
      onBudgetWarning: budget => this.lifecycle.onBudgetWarning(this.billingIdentity, budget),
      enforceBudgetStop: (budget, expected) =>
        this.lifecycle.enforceBudgetStop(this.billingIdentity, budget, expected),
    });
    this.lifecycle.attachHeartbeat(this.heartbeat);
  }

  private get billingIdentity(): BillingIdentity {
    return { sandboxClassName: this.identity.className };
  }

  /** True while a billing generation exists that has not completed settlement. */
  async hasUnsettledGeneration(): Promise<boolean> {
    return (await getBillingContext(this.host.storage)) !== undefined;
  }

  /**
   * Initiate settlement of the current generation through the shared lifecycle's
   * stop path. That path persists the observed physical-stop boundary and
   * delivers the final `recordStop` as a shadow task, so this never awaits
   * settlement on the caller's queue. Callers revalidate
   * `hasUnsettledGeneration()` before installing a replacement identity.
   */
  initiateSettlement(): Promise<void> {
    return this.onContainerStopped({ reason: 'runtime_signal' });
  }

  /**
   * Report the observed physical stop as `lastChange` once a heartbeat has
   * persisted it. The lifecycle derives the final usage boundary from this
   * observation, so settlement cannot bill past the persisted physical stop.
   */
  private async observedState(): Promise<{ status: string; lastChange?: number }> {
    const state = await this.host.container.getState();
    if (state.status !== 'stopped') return state;
    const context = await getBillingContext(this.host.storage);
    if (context?.stoppedObservedAtMs === undefined) return state;
    return { ...state, lastChange: context.stoppedObservedAtMs };
  }

  isBillingBlocked(): Promise<boolean> {
    return this.lifecycle.isBillingBlocked();
  }

  getBillingRuntimeStatus() {
    return this.lifecycle.getBillingRuntimeStatus(this.billingIdentity);
  }

  ensureBillingAdmission(input: unknown) {
    return this.lifecycle.ensureBillingAdmission(this.billingIdentity, input);
  }

  configureBilling(input: unknown) {
    return this.lifecycle.configureBilling(this.billingIdentity, input);
  }

  onContainerStarted() {
    return this.lifecycle.onContainerStarted(this.billingIdentity, async () => {});
  }

  onContainerStopped(params?: ContainerStopParams) {
    return this.lifecycle.onContainerStopped(this.billingIdentity, params, async () => {});
  }

  billingForceStop(generation: string) {
    return this.lifecycle.billingForceStop(this.billingIdentity, generation);
  }
}
