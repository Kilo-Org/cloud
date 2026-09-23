import {
  clearBillingContext,
  getBillingContext,
  setBillingContext,
  updateBillingContext,
  usageContextFromBillingContext,
  type BillingContext,
  type BillingContextStorage,
  type BillingGenerationCloseCause,
  type BillingHeartbeatController,
  type ClientRecordStartInput,
  type ContainerUsageClient,
  type UsageContext,
} from '@kilocode/container-usage';
import { z } from 'zod';
import { logger } from './logger.js';
import {
  assertSandboxBillingAllocation,
  billingCapacityForSandboxClass,
  parseSandboxBillingInput,
  SANDBOX_USAGE_SKUS,
  usageServiceForSandboxClass,
  billingAdmissionFailureFromError,
  type SandboxBillingAdmissionResult,
  type SandboxBillingInput,
  type SandboxClassName,
} from './container-usage-context.js';

const PENDING_ATTRIBUTION_STORAGE_KEY = 'container-usage:pending-attribution:v1';
const PENDING_STOP_REASON_STORAGE_KEY = 'container-usage:pending-stop-reason:v1';
const START_ACK_GENERATION_STORAGE_KEY = 'container-usage:start-ack-generation:v1';
const LAST_START_EPOCH_STORAGE_KEY = 'container-usage:last-start-epoch:v1';
const BILLING_BLOCK_STORAGE_KEY = 'container-usage:budget-block:v1';
const DESTROY_RECOVERY_MARKER_STORAGE_KEY_PREFIX = 'container-usage:destroy-recovery-marker:v1:';
const BILLING_FORCE_STOP_SECONDS = 120;
const BILLING_FORCE_STOP_RETRY_SECONDS = 5;

export type BillingIdentity = { sandboxClassName: SandboxClassName };

export type ContainerStopParams = { reason: 'exit' | 'runtime_signal'; exitCode?: number };

export type MeteredBillingHost = {
  storage: BillingContextStorage;
  usageClient: ContainerUsageClient;
  schedule: (delaySeconds: number, callback: string, payload?: unknown) => Promise<unknown>;
  deleteSchedules: (callback: string) => void;
  getState: () => Promise<{ status: string; lastChange?: number; exitCode?: number }>;
  isContainerRunning: () => boolean;
  stopContainer: () => Promise<void>;
  destroyContainer: () => Promise<void>;
  durableObjectId: string;
  waitUntil: (promise: Promise<unknown>) => void;
};

/**
 * Why a billing generation — and therefore a physical container run — began.
 * `container-start` is the SDK dispatching onStart; the other two adopt a container
 * that was already running when attribution or a replacement generation arrived.
 */
type ContainerStartTrigger = 'container-start' | 'attribution-adoption' | 'replacement-generation';

const pendingStopReasonSchema = z
  .object({
    generation: z.uuid(),
    reason: z.literal('activity_expired'),
  })
  .strict();

const billingBlockSchema = z
  .object({
    generation: z.uuid(),
    startEpochMs: z.number().int().nonnegative(),
    blockedAt: z.number().int().nonnegative(),
    forceStopAt: z.number().int().nonnegative(),
    remainingMicrodollars: z.number().int().optional(),
  })
  .strict();

function startInputFromContext(context: BillingContext): ClientRecordStartInput {
  const { service: _service, ...usage } = usageContextFromBillingContext(context);
  return { ...usage, startEpochMs: context.startEpochMs };
}

function stoppedAtFromState(
  state: { status: string; lastChange?: number },
  observedAtMs = Date.now()
): number {
  if (state.status !== 'stopped' && state.status !== 'stopped_with_code') return observedAtMs;
  return Number.isFinite(state.lastChange) &&
    state.lastChange !== undefined &&
    state.lastChange >= 0 &&
    state.lastChange <= observedAtMs
    ? state.lastChange
    : observedAtMs;
}

export class MeteredBillingLifecycle {
  private billingHeartbeat: BillingHeartbeatController | undefined;
  private billingLifecycleTail: Promise<void> = Promise.resolve();
  private activityExpiryRequested = false;

  constructor(private readonly host: MeteredBillingHost) {}

  attachHeartbeat(controller: BillingHeartbeatController): void {
    this.billingHeartbeat = controller;
  }

  private get heartbeat(): BillingHeartbeatController {
    if (!this.billingHeartbeat) {
      throw new Error('Billing heartbeat controller is not attached');
    }
    return this.billingHeartbeat;
  }

  async isBillingBlocked(): Promise<boolean> {
    return (await this.getBillingBlock()) !== undefined;
  }

  /** Read-only status: storage and container state only; this never wakes or admits. */
  async getBillingRuntimeStatus(identity: BillingIdentity): Promise<{
    sandboxClassName: SandboxClassName;
    running: boolean;
    blocked: boolean;
    context?: BillingContext;
  }> {
    return {
      sandboxClassName: identity.sandboxClassName,
      running: this.host.isContainerRunning(),
      blocked: (await this.getBillingBlock()) !== undefined,
      context: await getBillingContext(this.host.storage),
    };
  }

  async ensureBillingAdmission(
    identity: BillingIdentity,
    input: unknown
  ): Promise<SandboxBillingAdmissionResult> {
    const parsed = parseSandboxBillingInput(input);
    assertSandboxBillingAllocation(identity.sandboxClassName, parsed);
    return this.runBillingExclusive(async () => {
      await this.host.storage.put(PENDING_ATTRIBUTION_STORAGE_KEY, parsed);
      const block = await this.getBillingBlock();
      let active = await getBillingContext(this.host.storage);

      if (!block && !parsed.enforcementRequested) {
        return { success: true };
      }

      if (active && !active.measurementStarted && !block) {
        return { success: true };
      }

      if (active?.measurementStarted && this.host.isContainerRunning()) {
        if (block) {
          return {
            success: false,
            code: 'stopping',
            message: 'Container is stopping because its billing balance is too low',
            remainingMicrodollars: block.remainingMicrodollars,
          };
        }
        return { success: true };
      }

      if (this.host.isContainerRunning()) {
        return {
          success: false,
          code: 'stopping',
          message: 'Container billing admission is waiting for the previous run to stop',
        };
      }

      if (active) {
        try {
          await this.heartbeat.recordStop(
            { reason: 'runtime_signal' },
            stoppedAtFromState(await this.host.getState())
          );
          await this.host.storage.delete(START_ACK_GENERATION_STORAGE_KEY);
        } catch (error) {
          return {
            success: false,
            code: 'meter_unavailable',
            message:
              error instanceof Error ? error.message : 'Final usage settlement is unavailable',
          };
        }
        active = undefined;
      }

      const context = await this.createBillingGeneration(identity, parsed, 'attribution-adoption');
      try {
        await this.host.usageClient.recordStart(startInputFromContext(context));
      } catch (error) {
        await clearBillingContext(this.host.storage);
        return billingAdmissionFailureFromError(error);
      }
      await this.host.storage.put(START_ACK_GENERATION_STORAGE_KEY, context.generation);
      await this.host.storage.delete(BILLING_BLOCK_STORAGE_KEY);
      return { success: true };
    });
  }

  async configureBilling(identity: BillingIdentity, input: unknown): Promise<void> {
    const parsed = parseSandboxBillingInput(input);
    assertSandboxBillingAllocation(identity.sandboxClassName, parsed);
    await this.runBillingExclusive(async () => {
      await this.host.storage.put(PENDING_ATTRIBUTION_STORAGE_KEY, parsed);
      let active = await getBillingContext(this.host.storage);
      if (active?.pendingStop) {
        try {
          await this.heartbeat.recordStop(active.pendingStop);
          await this.host.storage.delete(START_ACK_GENERATION_STORAGE_KEY);
        } catch (error) {
          await this.deferBillingDelivery(identity, error, 'pending stop recovery');
          return;
        }
        active = undefined;
      }
      if (active?.measurementStarted) {
        if (this.host.isContainerRunning()) {
          try {
            await this.ensureStartAcknowledged(active);
          } catch (error) {
            await this.deferBillingDelivery(identity, error, 'active start acknowledgement');
          }
          return;
        }
        const state = await this.host.getState();
        const stoppedAtMs = active.stoppedObservedAtMs ?? stoppedAtFromState(state);
        try {
          await this.heartbeat.recordStop(
            {
              reason: 'runtime_signal',
              ...(state.status === 'stopped_with_code' && state.exitCode !== undefined
                ? { exitCode: state.exitCode }
                : {}),
            },
            stoppedAtMs
          );
          await this.host.storage.delete(START_ACK_GENERATION_STORAGE_KEY);
        } catch (error) {
          await this.deferBillingDelivery(identity, error, 'missed stop recovery');
          return;
        }
        active = undefined;
      }

      // A start may have succeeded before the DO was evicted or a prior admission response failed.
      // Retry the same idempotent start before allowing work to use that running generation.
      if (active) {
        const state = await this.host.getState();
        if (state.status !== 'stopped' && state.status !== 'stopped_with_code') {
          await this.admitAndScheduleBestEffort(identity, active);
          return;
        }
        const stoppedAtMs = active.stoppedObservedAtMs ?? stoppedAtFromState(state);
        try {
          await this.heartbeat.recordStop(
            {
              reason: 'runtime_signal',
              ...(state.status === 'stopped_with_code' && state.exitCode !== undefined
                ? { exitCode: state.exitCode }
                : {}),
            },
            stoppedAtMs
          );
          await this.host.storage.delete(START_ACK_GENERATION_STORAGE_KEY);
        } catch (error) {
          await this.deferBillingDelivery(identity, error, 'unmeasured stop recovery');
          return;
        }
      }

      // Adopt containers that were already running when shadow metering rolled out.
      if (this.host.isContainerRunning()) {
        await this.startBillingGeneration(identity, parsed, 'attribution-adoption');
      }
    });
  }

  async onContainerStarted(
    identity: BillingIdentity,
    startContainer: () => Promise<void>
  ): Promise<void> {
    await startContainer();
    this.runShadowTask(identity, 'start lifecycle', async () => {
      const block = await this.getBillingBlock();
      if (block) {
        await this.scheduleForceStop(block);
        await this.host.stopContainer();
        return;
      }
      const previous = await getBillingContext(this.host.storage);
      if (previous) {
        if (previous.pendingStop) {
          try {
            await this.heartbeat.recordStop(previous.pendingStop);
            await this.host.storage.delete(START_ACK_GENERATION_STORAGE_KEY);
          } catch (error) {
            await this.deferBillingDelivery(identity, error, 'start blocked by pending stop');
            return;
          }
        } else if (!previous.measurementStarted) {
          await this.admitAndScheduleBestEffort(identity, previous);
          return;
        } else {
          // The SDK can dispatch onStart more than once for concurrent callers waiting on one
          // physical start. Existing measured state is therefore already the current generation.
          try {
            await this.ensureStartAcknowledged(previous);
          } catch (error) {
            await this.deferBillingDelivery(identity, error, 'duplicate start acknowledgement');
          }
          return;
        }
      }

      const input = await this.getPendingAttribution();
      if (!input) {
        logger
          .withFields({ sandboxClass: identity.sandboxClassName })
          .warn('Container usage shadow start has no attribution');
        return;
      }

      await this.startBillingGeneration(identity, input, 'container-start');
    });
  }

  async onContainerStopped(
    identity: BillingIdentity,
    params: ContainerStopParams | undefined,
    stopContainer: () => Promise<void>
  ): Promise<void> {
    await stopContainer();
    // `onStop` is the first durable lifecycle signal after the container has
    // actually stopped. Do not use the earlier budget verdict or force-destroy
    // request as the usage boundary.
    const stoppedAtMs = await this.getObservedStopTime();
    const activityExpiryRequested = this.activityExpiryRequested;
    this.activityExpiryRequested = false;
    this.runShadowTask(identity, 'stop lifecycle', async () => {
      const context = await getBillingContext(this.host.storage);
      if (!context) return;
      const requestedReason = activityExpiryRequested
        ? 'activity_expired'
        : await this.getPendingStopReason(context.generation);
      // Pairs with `container_started`: reason plus lifetime makes idle-expiry patterns
      // queryable in logs instead of only in the usage tables.
      logger
        .withTags({ logTag: 'container_stopped', sandboxId: context.instanceId })
        .withFields({
          sandboxClass: identity.sandboxClassName,
          generation: context.generation,
          startEpochMs: context.startEpochMs,
          reason: requestedReason ?? params?.reason ?? 'runtime_signal',
          exitCode: params?.exitCode,
          lifetimeMs: stoppedAtMs - context.startEpochMs,
          sessionId: context.sessionId,
        })
        .info('Container stopped');
      const pending = await this.heartbeat.persistStop(
        {
          reason: requestedReason ?? params?.reason ?? 'runtime_signal',
          exitCode: params?.exitCode,
        },
        stoppedAtMs
      );
      if (!pending) return;
      await this.ensureStartAcknowledged(pending);
      await this.heartbeat.recordStop({
        reason: requestedReason ?? params?.reason ?? 'runtime_signal',
        exitCode: params?.exitCode,
      });
      await this.host.storage.delete(START_ACK_GENERATION_STORAGE_KEY);
      await this.host.storage.delete(PENDING_STOP_REASON_STORAGE_KEY);
    });
  }

  async onActivityExpired(
    identity: BillingIdentity,
    expireActivity: () => Promise<void>
  ): Promise<void> {
    this.activityExpiryRequested = true;
    await expireActivity();
    this.runShadowTask(identity, 'activity expiry', async () => {
      const context = await getBillingContext(this.host.storage);
      if (context) {
        await this.host.storage.put(PENDING_STOP_REASON_STORAGE_KEY, {
          generation: context.generation,
          reason: 'activity_expired',
        });
      }
    });
  }

  onGenerationClosed(
    identity: BillingIdentity,
    _context: BillingContext,
    cause?: BillingGenerationCloseCause
  ): void {
    if (cause?.nonRetryableSkuAdmissionCode) {
      // The stored attribution cannot start on this SKU. Drop it on the
      // billing queue instead of immediately starting a replacement
      // generation that would fail the same way. Serializing the delete
      // keeps a write ordered before this close from surviving as a new
      // generation.
      this.runShadowTask(identity, 'terminal SKU admission cleanup', async () => {
        await this.host.storage.delete(PENDING_ATTRIBUTION_STORAGE_KEY);
      });
      return;
    }
    this.schedulePendingGenerationIfRunning(identity);
  }

  async onBudgetWarning(
    identity: BillingIdentity,
    budget: { verdict: string; remainingMicrodollars?: number }
  ): Promise<void> {
    const context = await getBillingContext(this.host.storage);
    logger
      .withTags({ logTag: 'container_billing_warning' })
      .withFields({
        sandboxClass: identity.sandboxClassName,
        billingMode: 'paid',
        verdict: budget.verdict,
        remainingMicrodollars: budget.remainingMicrodollars,
        generation: context?.generation,
        subjectType: context?.subject.type,
        sessionId: context?.sessionId,
      })
      .warn('Container billing balance is approaching the stop threshold');
  }

  async enforceBudgetStop(
    identity: BillingIdentity,
    budget: { verdict: string; remainingMicrodollars?: number },
    expected: { generation: string; startEpochMs: number }
  ): Promise<void> {
    const active = await getBillingContext(this.host.storage);
    if (
      !active ||
      active.generation !== expected.generation ||
      active.startEpochMs !== expected.startEpochMs
    ) {
      return;
    }
    const existing = await this.getBillingBlock();
    if (existing && existing.generation !== expected.generation) return;
    const block =
      existing ??
      ({
        generation: expected.generation,
        startEpochMs: expected.startEpochMs,
        blockedAt: Date.now(),
        forceStopAt: Date.now() + BILLING_FORCE_STOP_SECONDS * 1_000,
        remainingMicrodollars: budget.remainingMicrodollars,
      } satisfies z.infer<typeof billingBlockSchema>);
    if (!existing) await this.host.storage.put(BILLING_BLOCK_STORAGE_KEY, block);
    await this.scheduleForceStop(block);
    logger
      .withTags({ logTag: 'container_billing_stop' })
      .withFields({
        sandboxClass: identity.sandboxClassName,
        generation: expected.generation,
        remainingMicrodollars: budget.remainingMicrodollars,
        forceStopAt: block.forceStopAt,
      })
      .warn('Container billing stop initiated');
    await this.host.stopContainer();
  }

  async billingForceStop(identity: BillingIdentity, generation: string): Promise<void> {
    return this.runBillingExclusive(() => this.forceStopBillingGeneration(identity, generation));
  }

  async ensureStartAcknowledged(context: BillingContext): Promise<void> {
    const acknowledgedGeneration = await this.host.storage.get<string>(
      START_ACK_GENERATION_STORAGE_KEY
    );
    if (acknowledgedGeneration !== context.generation) {
      await this.host.usageClient.recordStart(startInputFromContext(context));
      await this.host.storage.put(START_ACK_GENERATION_STORAGE_KEY, context.generation);
    }
  }

  async destroyWithBillingRecovery(performDestroy: () => Promise<void>): Promise<void> {
    const context = await getBillingContext(this.host.storage);
    const block = await this.getBillingBlock();
    const startAcknowledgement = await this.host.storage.get<string>(
      START_ACK_GENERATION_STORAGE_KEY
    );
    const pendingStopReason = context
      ? await this.getPendingStopReason(context.generation)
      : undefined;
    const recoveryMarkerKey = `${DESTROY_RECOVERY_MARKER_STORAGE_KEY_PREFIX}${crypto.randomUUID()}`;
    await this.host.storage.put(recoveryMarkerKey, true);
    await performDestroy();
    const currentRecoveryMarker = await this.host.storage.get<boolean>(recoveryMarkerKey);
    if (currentRecoveryMarker !== undefined) {
      await this.host.storage.delete(recoveryMarkerKey);
      return;
    }
    let currentContext = await getBillingContext(this.host.storage);
    if (!currentContext && context) {
      await updateBillingContext(this.host.storage, context);
      currentContext = context;
    }
    const currentBlock = await this.getBillingBlock();
    if (
      !currentBlock &&
      block &&
      currentContext?.generation === block.generation &&
      currentContext.startEpochMs === block.startEpochMs
    ) {
      await this.host.storage.put(BILLING_BLOCK_STORAGE_KEY, block);
    }
    const currentStartAcknowledgement = await this.host.storage.get<string>(
      START_ACK_GENERATION_STORAGE_KEY
    );
    if (
      currentStartAcknowledgement === undefined &&
      startAcknowledgement === currentContext?.generation
    ) {
      await this.host.storage.put(START_ACK_GENERATION_STORAGE_KEY, startAcknowledgement);
    }
    const currentPendingStopReason = await this.host.storage.get(PENDING_STOP_REASON_STORAGE_KEY);
    if (
      pendingStopReason &&
      context &&
      currentPendingStopReason === undefined &&
      context.generation === currentContext?.generation
    ) {
      await this.host.storage.put(PENDING_STOP_REASON_STORAGE_KEY, {
        generation: context.generation,
        reason: pendingStopReason,
      });
    }
  }

  private runBillingExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.billingLifecycleTail.then(operation, operation);
    this.billingLifecycleTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private runShadowTask(
    identity: BillingIdentity,
    operation: string,
    task: () => Promise<void>
  ): void {
    const promise = this.runBillingExclusive(task).catch(error => {
      this.logShadowFailure(identity, error, operation);
    });
    this.host.waitUntil(promise);
  }

  private schedulePendingGenerationIfRunning(identity: BillingIdentity): void {
    this.runShadowTask(identity, 'replacement generation', async () => {
      if (await this.getBillingBlock()) return;
      if (!this.host.isContainerRunning()) return;
      if (await getBillingContext(this.host.storage)) return;
      const input = await this.getPendingAttribution();
      if (input) await this.startBillingGeneration(identity, input, 'replacement-generation');
    });
  }

  private async getPendingAttribution(): Promise<SandboxBillingInput | undefined> {
    const stored = await this.host.storage.get(PENDING_ATTRIBUTION_STORAGE_KEY);
    return stored === undefined ? undefined : parseSandboxBillingInput(stored);
  }

  private async getPendingStopReason(generation: string): Promise<'activity_expired' | undefined> {
    const stored = await this.host.storage.get(PENDING_STOP_REASON_STORAGE_KEY);
    if (stored === undefined) return undefined;
    const parsed = pendingStopReasonSchema.parse(stored);
    return parsed.generation === generation ? parsed.reason : undefined;
  }

  private async admitAndScheduleBestEffort(
    identity: BillingIdentity,
    context: BillingContext
  ): Promise<void> {
    try {
      await this.ensureStartAcknowledged(context);
    } catch (error) {
      await this.deferBillingDelivery(identity, error, 'start acknowledgement');
      return;
    }
    try {
      await this.heartbeat.scheduleHeartbeat();
    } catch (error) {
      await this.deferBillingDelivery(identity, error, 'heartbeat scheduling', false);
    }
  }

  private async deferBillingDelivery(
    identity: BillingIdentity,
    error: unknown,
    operation: string,
    scheduleRetry = true
  ): Promise<void> {
    if (scheduleRetry) {
      try {
        await this.heartbeat.scheduleHeartbeat();
      } catch {
        // A later sandbox acquisition retries persisted shadow state.
      }
    }
    this.logShadowFailure(identity, error, operation);
  }

  private logShadowFailure(identity: BillingIdentity, error: unknown, operation: string): void {
    logger
      .withFields({
        error: error instanceof Error ? error.message : String(error),
        operation,
        sandboxClass: identity.sandboxClassName,
      })
      .warn('Container usage shadow delivery deferred');
  }

  private async getBillingBlock() {
    const stored = await this.host.storage.get(BILLING_BLOCK_STORAGE_KEY);
    return stored === undefined ? undefined : billingBlockSchema.parse(stored);
  }

  private async getObservedStopTime(): Promise<number> {
    try {
      return stoppedAtFromState(await this.host.getState());
    } catch {
      // The lifecycle callback itself is still authoritative when the control
      // plane cannot provide a state transition timestamp.
      return Date.now();
    }
  }

  private async scheduleForceStop(block: z.infer<typeof billingBlockSchema>): Promise<void> {
    const delaySeconds = Math.max(0, Math.ceil((block.forceStopAt - Date.now()) / 1_000));
    this.host.deleteSchedules('billingForceStop');
    await this.host.schedule(delaySeconds, 'billingForceStop', block.generation);
  }

  private async forceStopBillingGeneration(
    identity: BillingIdentity,
    generation: string
  ): Promise<void> {
    const block = await this.getBillingBlock();
    if (!block || block.generation !== generation) return;
    const active = await getBillingContext(this.host.storage);
    if (
      !active ||
      active.generation !== block.generation ||
      active.startEpochMs !== block.startEpochMs
    )
      return;
    logger
      .withTags({ logTag: 'container_billing_force_stop' })
      .withFields({
        sandboxClass: identity.sandboxClassName,
        generation,
        stopLatencyMs: Date.now() - block.blockedAt,
      })
      .error('Force-destroying container after billing stop deadline');
    try {
      // The control plane may fail after the deadline. Keep the durable block and
      // reissue destroy until the physical stop hook settles the generation.
      await this.host.destroyContainer();
    } catch (error) {
      logger
        .withFields({
          error: error instanceof Error ? error.message : String(error),
          sandboxClass: identity.sandboxClassName,
          generation,
        })
        .warn('Billing force-destroy issuance failed; retrying');
      await this.host.schedule(BILLING_FORCE_STOP_RETRY_SECONDS, 'billingForceStop', generation);
      throw error;
    }
  }

  private async createBillingGeneration(
    identity: BillingIdentity,
    input: SandboxBillingInput,
    trigger: ContainerStartTrigger
  ): Promise<BillingContext> {
    const capacity = billingCapacityForSandboxClass(identity.sandboxClassName);
    const previousStartEpochMs =
      (await this.host.storage.get<number>(LAST_START_EPOCH_STORAGE_KEY)) ?? -1;
    const startEpochMs = Math.max(Date.now(), previousStartEpochMs + 1);
    await this.host.storage.put(LAST_START_EPOCH_STORAGE_KEY, startEpochMs);
    const context = await setBillingContext(this.host.storage, {
      subject: input.subject,
      actor: input.actor,
      ...(input.onBehalfOf ? { onBehalfOf: input.onBehalfOf } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      service: usageServiceForSandboxClass(identity.sandboxClassName),
      instanceId: input.sandboxId,
      sku: SANDBOX_USAGE_SKUS[identity.sandboxClassName],
      metadata: {
        container_class: identity.sandboxClassName,
        durable_object_id: this.host.durableObjectId,
        vcpu: String(capacity.vcpu),
        memory_mib: String(capacity.memoryMiB),
        disk_mb: String(capacity.diskMB),
        ...(input.metadata?.origin ? { origin: input.metadata.origin } : {}),
      },
      startEpochMs,
    } satisfies UsageContext & { startEpochMs: number });
    await this.host.storage.delete(PENDING_STOP_REASON_STORAGE_KEY);
    logger
      .withTags({ logTag: 'container_started', sandboxId: input.sandboxId })
      .withFields({
        sandboxClass: identity.sandboxClassName,
        generation: context.generation,
        startEpochMs,
        trigger,
        sessionId: input.sessionId,
        durableObjectId: this.host.durableObjectId,
      })
      .info('Container billing generation created');
    return context;
  }

  private async startBillingGeneration(
    identity: BillingIdentity,
    input: SandboxBillingInput,
    trigger: ContainerStartTrigger
  ): Promise<void> {
    const context = await this.createBillingGeneration(identity, input, trigger);
    await this.admitAndScheduleBestEffort(identity, context);
  }
}
