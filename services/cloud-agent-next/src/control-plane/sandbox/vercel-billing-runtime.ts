import {
  clearBillingContext,
  ContainerUsageAdmissionError,
  createContainerUsageClient,
  DEFAULT_BILLING_HEARTBEAT_SECONDS,
  getBillingContext,
  installBillingHeartbeat,
  type BillingHeartbeatController,
} from '@kilocode/container-usage';
import { withTimeout } from '@kilocode/worker-utils';
import type { VercelSandboxResources } from '@kilocode/worker-utils/sandbox-allocation';
import {
  assertSandboxBillingAllocation,
  vercelBillingIdentity,
} from '../../container-usage-context.js';
import { isCloudAgentContainerBillingEnabled } from '../../container-billing-rollout.js';
import { MeteredBillingLifecycle, type BillingIdentity } from '../../metered-billing-lifecycle.js';
import type { BillingScheduleTable } from '../../sandbox-control/billing-schedule.js';
import {
  VercelBilling,
  VERCEL_BILLING_SETTLEMENT_CALLBACK,
  deleteVercelBillingBinding,
  loadVercelBillingBinding,
  saveVercelBillingBinding,
} from '../../sandbox-control/vercel-billing.js';
import { decodeVercelProviderRef } from '../../sandbox-control/vercel-provider.js';
import type { ProviderAdapter } from '../../sandbox-control/provider.js';
import type { AgentSandboxProvider, Env } from '../../types.js';
import type { AllocationEvent, AllocationState, SandboxTimers } from './allocation.js';
import type { StoredProviderPin } from './sandbox-do.js';

export const VERCEL_BILLING_FORCE_STOP_CALLBACK = 'billingForceStop';
export const VERCEL_BILLING_DELIVERY_RETRY_MS = 5_000;

export type VercelBillingLifetimeEvidence = {
  providerRef: string;
  createdAtMs?: number;
  terminalAtMs?: number;
};

type VercelBillingRuntimeState = {
  identity: BillingIdentity | undefined;
  lifecycle: MeteredBillingLifecycle;
  heartbeat: BillingHeartbeatController;
  billing: VercelBilling;
};

/**
 * Authoritative accessors. Every value is read live from the Durable Object's
 * current pin, allocation and storage, so a helper built before an allocation
 * exists (or before eviction restores the pin) still describes the current
 * sandbox rather than constructor-frozen defaults.
 */
export type VercelBillingRuntimeDeps = {
  storage: DurableObjectStorage;
  env: () => Env;
  sandboxId: string;
  schedule: BillingScheduleTable;
  currentProvider: () => AgentSandboxProvider;
  currentPin: () => StoredProviderPin | null;
  readAllocation: () => Promise<AllocationState>;
  requireOwner: () => Promise<string | null>;
  isCreateInFlight: () => boolean;
  provider: () => ProviderAdapter;
  timers: () => SandboxTimers;
  /** Bounded provider stop that reports a confirmed terminal stop. */
  stopRef: (ref: string, allocationId: string | null) => Promise<boolean>;
  /**
   * Fail-closed cleanup path for an unconfirmed Vercel stop: fails the
   * preparing routes and the creating allocation. Owned by the DO because it
   * mutates the allocation/reducer state.
   */
  failUnconfirmedCleanup: (state: AllocationState) => Promise<void>;
  /**
   * Commit a billing stop request to the allocation. Resolves after the
   * request is durable, not after the sandbox stops.
   */
  requestStop: () => Promise<void>;
  waitUntil: (promise: Promise<unknown>) => void;
};

export type VercelBillingRuntime = {
  ensureRuntime: () => Promise<VercelBillingRuntimeState | undefined>;
  admitCreate: (
    pin: StoredProviderPin
  ) => Promise<'admitted' | 'blocked' | 'unavailable' | 'retry'>;
  admitShadow: (pin: StoredProviderPin) => Promise<boolean>;
  recordLifetime: (evidence: VercelBillingLifetimeEvidence) => Promise<void>;
  settleStoppedCreatedRef: (ref: string, confirmed: boolean) => Promise<void>;
  afterTransition: (event: AllocationEvent) => Promise<void>;
  prepareSettlement: (generation: string) => Promise<void>;
  runAlarm: () => Promise<void>;
  defer: (generation: string, callback: string) => Promise<void>;
};

/**
 * Vercel metered-billing runtime: construction and caching of the lifecycle,
 * heartbeat and settlement owner, admission and shadow fallback, lifetime
 * evidence, settlement scheduling and the billing alarm body. All durable
 * state reads and the stop/fail-closed decisions are delegated back to the
 * Durable Object through `deps`; this module never touches the allocation
 * reducer or re-arms the alarm itself.
 */
export function createVercelBillingRuntime(deps: VercelBillingRuntimeDeps): VercelBillingRuntime {
  let runtime: VercelBillingRuntimeState | undefined;
  let build: Promise<void> | undefined;
  const deliveriesInFlight = new Set<string>();

  function vercelResources(): VercelSandboxResources | undefined {
    const configuration = deps.currentPin()?.configuration;
    return configuration?.provider === 'vercel' ? configuration.resources : undefined;
  }

  async function containerState(): Promise<{ status: string; lastChange?: number }> {
    const context = await getBillingContext(deps.storage);
    if (context === undefined) return { status: 'running' };
    const binding = await loadVercelBillingBinding(deps.storage, context.generation);
    if (binding?.terminalAtMs !== undefined)
      return { status: 'stopped', lastChange: binding.terminalAtMs };
    if (binding === undefined || deps.currentProvider() !== 'vercel') return { status: 'running' };
    try {
      const observed = await deps.provider().observe(binding.providerRef);
      if (observed.status !== 'terminal') return { status: 'running' };
      const refreshed = await loadVercelBillingBinding(deps.storage, context.generation);
      return {
        status: 'stopped',
        lastChange: refreshed?.terminalAtMs ?? context.usageMeasuredAtMs ?? binding.createdAtMs,
      };
    } catch {
      return { status: 'running' };
    }
  }

  async function buildRuntime(): Promise<void> {
    const resources = vercelResources();
    const vercelIdentity = resources === undefined ? undefined : vercelBillingIdentity(resources);
    const service = vercelIdentity?.service ?? (await getBillingContext(deps.storage))?.service;
    if (service === undefined) return;
    const identity: BillingIdentity | undefined =
      vercelIdentity === undefined ? undefined : { sandboxClassName: vercelIdentity.className };
    const usageClient = createContainerUsageClient(deps.env().CONTAINER_USAGE_METER, { service });
    const schedule = (delaySeconds: number, callback: string, payload?: unknown) =>
      deps.schedule.schedule(callback, Date.now() + delaySeconds * 1_000, payload);
    const deleteSchedules = (callback: string) => {
      if (callback !== VERCEL_BILLING_SETTLEMENT_CALLBACK)
        void deps.schedule.remove(callback).catch(() => undefined);
    };
    const getState = () => containerState();
    const stopContainer = async () => {
      const generation = (await getBillingContext(deps.storage))?.generation;
      deps.waitUntil(
        deps.requestStop().catch(async () => {
          if (generation !== undefined) {
            await deps.schedule.schedule(
              VERCEL_BILLING_FORCE_STOP_CALLBACK,
              Date.now() + VERCEL_BILLING_DELIVERY_RETRY_MS,
              generation
            );
          }
        })
      );
    };
    const lifecycle = new MeteredBillingLifecycle({
      storage: deps.storage,
      usageClient,
      schedule,
      deleteSchedules,
      getState,
      isContainerRunning: () => false,
      stopContainer,
      destroyContainer: stopContainer,
      durableObjectId: deps.sandboxId,
      waitUntil: promise => deps.waitUntil(promise),
    });
    const heartbeat = installBillingHeartbeat(
      { schedule, deleteSchedules, getState } as unknown as Parameters<
        typeof installBillingHeartbeat
      >[0],
      {
        client: usageClient,
        storage: deps.storage,
        stopOnStoppedState: false,
        deferBudgetStopFinalSettlement: true,
        beforeHeartbeatDelivery: context => lifecycle.ensureStartAcknowledged(context),
        beforeStopDelivery: context => lifecycle.ensureStartAcknowledged(context),
        onGenerationClosed: context => runtime?.billing.onGenerationClosed(context),
        enforceBudgetStop: async (budget, expected) => {
          if (identity === undefined) throw new Error('Vercel billing identity is unavailable');
          await lifecycle.enforceBudgetStop(identity, budget, expected);
        },
        onBudgetWarning: async budget => {
          if (identity !== undefined) await lifecycle.onBudgetWarning(identity, budget);
        },
      }
    );
    lifecycle.attachHeartbeat(heartbeat);
    runtime = {
      identity,
      lifecycle,
      heartbeat,
      billing: new VercelBilling({
        storage: deps.storage,
        lifecycle,
        heartbeat,
        schedule: deps.schedule,
      }),
    };
  }

  async function ensureRuntime(): Promise<VercelBillingRuntimeState | undefined> {
    if (runtime !== undefined && (await getBillingContext(deps.storage)) === undefined) {
      const resources = vercelResources();
      const className =
        resources === undefined ? undefined : vercelBillingIdentity(resources).className;
      if (runtime.identity?.sandboxClassName !== className) runtime = undefined;
    }
    if (runtime !== undefined) return runtime;
    if (build !== undefined) {
      await build;
      return runtime;
    }
    const started = buildRuntime();
    build = started;
    try {
      await started;
    } finally {
      if (build === started) build = undefined;
    }
    return runtime;
  }

  async function prepareSettlement(generation: string): Promise<void> {
    const active = await ensureRuntime();
    if (active === undefined) return;
    await active.billing.prepareSettlement({ generation });
  }

  async function admitCreate(
    pin: StoredProviderPin
  ): Promise<'admitted' | 'blocked' | 'unavailable' | 'retry'> {
    const existing = await getBillingContext(deps.storage);
    if (existing !== undefined) {
      await deps.schedule.ensure(
        VERCEL_BILLING_SETTLEMENT_CALLBACK,
        Date.now() + DEFAULT_BILLING_HEARTBEAT_SECONDS * 1_000,
        existing.generation
      );
      await prepareSettlement(existing.generation);
      return 'retry';
    }
    const billing = pin.billing;
    const owner = await deps.requireOwner();
    if (billing === null) {
      return owner !== null && !isCloudAgentContainerBillingEnabled(deps.env(), { userId: owner })
        ? 'admitted'
        : 'unavailable';
    }
    if (billing.sandboxId !== deps.sandboxId) return 'unavailable';
    if (
      owner === null ||
      (billing.subject.type === 'user' && billing.subject.id !== owner) ||
      (billing.actor.type === 'user' && billing.actor.id !== owner)
    )
      return 'unavailable';
    const enforced =
      billing.enforcementRequested === true ||
      isCloudAgentContainerBillingEnabled(deps.env(), {
        userId: owner,
        ...(billing.subject.type === 'org' ? { orgId: billing.subject.id } : {}),
      });
    const active = await ensureRuntime();
    if (active?.identity === undefined) return 'unavailable';
    try {
      assertSandboxBillingAllocation(active.identity.sandboxClassName, billing);
    } catch {
      return 'unavailable';
    }
    const outcome = await active.lifecycle.openIntervalBeforeCreate(active.identity, {
      ...billing,
      enforcementRequested: enforced,
    });
    await deps.schedule.ensure(
      VERCEL_BILLING_SETTLEMENT_CALLBACK,
      Date.now() + DEFAULT_BILLING_HEARTBEAT_SECONDS * 1_000,
      outcome.generation
    );
    if (outcome.kind === 'acked') return 'admitted';
    if (outcome.kind === 'definite_rejection') {
      await clearBillingContext(deps.storage);
      await deleteVercelBillingBinding(deps.storage, outcome.generation);
      await deps.schedule.remove(VERCEL_BILLING_SETTLEMENT_CALLBACK, outcome.generation);
      return enforced &&
        outcome.error instanceof ContainerUsageAdmissionError &&
        outcome.error.code === 'insufficient_credits'
        ? 'blocked'
        : enforced
          ? 'unavailable'
          : 'admitted';
    }
    if (!enforced) return 'admitted';
    await prepareSettlement(outcome.generation);
    return 'retry';
  }

  async function admitShadow(pin: StoredProviderPin): Promise<boolean> {
    const billing = pin.billing;
    const owner = await deps.requireOwner();
    const resources =
      pin.configuration?.provider === 'vercel' ? pin.configuration.resources : undefined;
    if (
      billing === null ||
      owner === null ||
      resources === undefined ||
      billing.enforcementRequested ||
      billing.sandboxId !== deps.sandboxId ||
      (billing.subject.type === 'user' && billing.subject.id !== owner) ||
      (billing.actor.type === 'user' && billing.actor.id !== owner) ||
      isCloudAgentContainerBillingEnabled(deps.env(), {
        userId: owner,
        ...(billing.subject.type === 'org' ? { orgId: billing.subject.id } : {}),
      })
    )
      return false;
    let identity: ReturnType<typeof vercelBillingIdentity>;
    try {
      identity = vercelBillingIdentity(resources);
      assertSandboxBillingAllocation(identity.className, billing);
    } catch {
      return false;
    }
    const context = await getBillingContext(deps.storage);
    if (
      context === undefined ||
      context.pendingStop !== undefined ||
      context.measurementStarted ||
      context.instanceId !== deps.sandboxId ||
      context.service !== identity.service ||
      context.sku !== identity.sku ||
      context.subject.type !== billing.subject.type ||
      context.subject.id !== billing.subject.id ||
      context.actor.type !== billing.actor.type ||
      context.actor.id !== billing.actor.id ||
      (await loadVercelBillingBinding(deps.storage, context.generation)) !== undefined
    )
      return false;
    await deps.schedule.ensure(
      VERCEL_BILLING_SETTLEMENT_CALLBACK,
      Date.now() + DEFAULT_BILLING_HEARTBEAT_SECONDS * 1_000,
      context.generation
    );
    return true;
  }

  async function recordLifetime(evidence: VercelBillingLifetimeEvidence): Promise<void> {
    const context = await getBillingContext(deps.storage);
    if (context === undefined) return;
    const existing = await loadVercelBillingBinding(deps.storage, context.generation);
    if (existing !== undefined && existing.providerRef !== evidence.providerRef) return;
    const allocation = await deps.readAllocation();
    if (allocation.providerRef !== null) {
      if (allocation.providerRef !== evidence.providerRef) return;
    } else {
      if (
        allocation.kind === 'stopped' ||
        existing !== undefined ||
        evidence.createdAtMs === undefined
      )
        return;
      const decoded = decodeVercelProviderRef(evidence.providerRef);
      if (decoded?.sandboxName !== (deps.currentPin()?.allocationName ?? deps.sandboxId)) return;
    }
    const createdAtMs = evidence.createdAtMs ?? existing?.createdAtMs;
    if (createdAtMs === undefined) return;
    const terminalAtMs = evidence.terminalAtMs ?? existing?.terminalAtMs;
    if (existing?.createdAtMs === createdAtMs && existing.terminalAtMs === terminalAtMs) return;
    await saveVercelBillingBinding(deps.storage, {
      generation: context.generation,
      providerRef: evidence.providerRef,
      createdAtMs,
      ...(terminalAtMs === undefined ? {} : { terminalAtMs }),
    });
    if (terminalAtMs !== undefined) await prepareSettlement(context.generation);
  }

  async function settleStoppedCreatedRef(ref: string, confirmed: boolean): Promise<void> {
    const context = await getBillingContext(deps.storage);
    if (context === undefined) return;
    const binding = await loadVercelBillingBinding(deps.storage, context.generation);
    if (binding?.providerRef !== ref) return;
    if (!confirmed && binding.terminalAtMs === undefined) {
      const allocation = await deps.readAllocation();
      await deps.schedule.schedule(
        VERCEL_BILLING_SETTLEMENT_CALLBACK,
        Date.now() +
          (allocation.kind === 'stopped'
            ? DEFAULT_BILLING_HEARTBEAT_SECONDS * 1_000
            : VERCEL_BILLING_DELIVERY_RETRY_MS),
        context.generation
      );
      return;
    }
    const terminalAtMs =
      binding.terminalAtMs ?? Math.max(binding.createdAtMs, context.usageMeasuredAtMs);
    if (binding.terminalAtMs === undefined) {
      await saveVercelBillingBinding(deps.storage, { ...binding, terminalAtMs });
    }
    await (
      await ensureRuntime()
    )?.heartbeat.persistStop({ reason: 'runtime_signal' }, terminalAtMs);
    await prepareSettlement(context.generation);
  }

  async function afterTransition(event: AllocationEvent): Promise<void> {
    const context = await getBillingContext(deps.storage);
    if (context === undefined) return;
    const binding = await loadVercelBillingBinding(deps.storage, context.generation);
    const state = await deps.readAllocation();
    if (
      state.kind === 'stopped' &&
      binding !== undefined &&
      binding.terminalAtMs === undefined &&
      !context.pendingStop &&
      event.type !== 'provider-gone' &&
      !(event.type === 'stop-result' && event.confirmed)
    ) {
      await deps.schedule.schedule(
        VERCEL_BILLING_SETTLEMENT_CALLBACK,
        Date.now() + VERCEL_BILLING_DELIVERY_RETRY_MS,
        context.generation
      );
      return;
    }
    if (state.kind === 'stopped' && !context.pendingStop) {
      await (
        await ensureRuntime()
      )?.heartbeat.persistStop(
        { reason: 'runtime_signal' },
        binding?.terminalAtMs ?? context.usageMeasuredAtMs
      );
    }
    if (context.pendingStop || binding?.terminalAtMs !== undefined || state.kind === 'stopped') {
      await prepareSettlement(context.generation);
    } else if (
      binding !== undefined &&
      !context.measurementStarted &&
      (state.kind === 'starting' || state.kind === 'connected' || state.kind === 'disconnected')
    ) {
      await (
        await ensureRuntime()
      )?.lifecycle.pinMeasurementCursor(context.generation, binding.createdAtMs);
    }
  }

  async function runAlarm(): Promise<void> {
    for (const entry of await deps.schedule.dueEntries()) {
      const generation = typeof entry.payload === 'string' ? entry.payload : null;
      if (generation === null) {
        await deps.schedule.completeDue(entry);
        continue;
      }
      const context = await getBillingContext(deps.storage);
      if (context?.generation !== generation) {
        await deps.schedule.completeDue(entry);
        await deleteVercelBillingBinding(deps.storage, generation);
        continue;
      }
      const active = await ensureRuntime();
      if (active === undefined) {
        await defer(generation, entry.callback);
        continue;
      }
      if (entry.callback === VERCEL_BILLING_FORCE_STOP_CALLBACK) {
        if (active.identity === undefined) {
          await defer(generation, entry.callback);
          continue;
        }
        try {
          await active.lifecycle.billingForceStop(active.identity, generation);
          if ((await deps.readAllocation()).kind === 'stopped') {
            await deps.schedule.completeDue(entry);
          } else {
            await defer(generation, entry.callback);
          }
        } catch {
          await defer(generation, entry.callback);
        }
        continue;
      }
      if (entry.callback !== VERCEL_BILLING_SETTLEMENT_CALLBACK) {
        await deps.schedule.completeDue(entry);
        continue;
      }
      const binding = await loadVercelBillingBinding(deps.storage, generation);
      const state = await deps.readAllocation();
      if (
        (state.kind === 'stopped' || (state.kind === 'creating' && !deps.isCreateInFlight())) &&
        binding !== undefined &&
        binding.terminalAtMs === undefined &&
        !context.pendingStop
      ) {
        const observation = await withTimeout(
          deps.provider().observe(binding.providerRef),
          deps.timers().providerStopAttemptMs,
          'Sandbox billing cleanup observation timed out'
        ).catch(() => ({ status: 'unknown' as const }));
        const confirmed =
          observation.status === 'terminal' ||
          (await deps.stopRef(binding.providerRef, state.allocationId));
        await settleStoppedCreatedRef(binding.providerRef, confirmed);
        if (!confirmed && Date.now() >= context.startEpochMs + deps.timers().providerCreateMs) {
          await deps.failUnconfirmedCleanup(state);
        }
        continue;
      }
      if (
        context.pendingStop ||
        binding?.terminalAtMs !== undefined ||
        state.kind === 'stopped' ||
        (state.kind === 'creating' &&
          !deps.isCreateInFlight() &&
          binding === undefined &&
          !context.measurementStarted)
      ) {
        if (deliveriesInFlight.has(generation)) {
          await defer(generation, entry.callback);
          continue;
        }
        deliveriesInFlight.add(generation);
        await defer(generation, entry.callback);
        deps.waitUntil(
          active.billing
            .deliverSettlement(generation)
            .catch(() => defer(generation, entry.callback))
            .finally(() => deliveriesInFlight.delete(generation))
        );
      } else if (!context.measurementStarted) {
        await deps.schedule.schedule(
          entry.callback,
          Date.now() + DEFAULT_BILLING_HEARTBEAT_SECONDS * 1_000,
          generation
        );
      } else {
        try {
          await active.heartbeat.billingHeartbeatTick(generation);
        } catch {
          await defer(generation, entry.callback);
        }
      }
    }
  }

  async function defer(generation: string, callback: string): Promise<void> {
    await deps.schedule.deferRetry(
      callback,
      generation,
      Date.now() + VERCEL_BILLING_DELIVERY_RETRY_MS
    );
  }

  return {
    ensureRuntime,
    admitCreate,
    admitShadow,
    recordLifetime,
    settleStoppedCreatedRef,
    afterTransition,
    prepareSettlement,
    runAlarm,
    defer,
  };
}
