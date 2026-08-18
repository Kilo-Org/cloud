import {
  clearBillingContext,
  createContainerUsageClient,
  getBillingContext,
  installBillingHeartbeat,
  setBillingContext,
  usageContextFromBillingContext,
  type BillingContext,
  type BillingHeartbeatController,
  type ClientRecordStartInput,
  type ContainerUsageClient,
  type UsageContext,
} from '@kilocode/container-usage';
import { Sandbox as StockSandbox } from '@cloudflare/sandbox';
import { z } from 'zod';
import { logger } from './logger.js';
import type { Env } from './types.js';
import {
  assertSandboxBillingAllocation,
  parseSandboxBillingInput,
  SANDBOX_CAPACITIES,
  SANDBOX_USAGE_SKUS,
  type SandboxBillingInput,
  type SandboxBillingAdmissionResult,
  type SandboxClassName,
} from './container-usage-context.js';

const SERVICE = 'cloud-agent-next';
const PENDING_ATTRIBUTION_STORAGE_KEY = 'container-usage:pending-attribution:v1';
const PENDING_STOP_REASON_STORAGE_KEY = 'container-usage:pending-stop-reason:v1';
const START_ACK_GENERATION_STORAGE_KEY = 'container-usage:start-ack-generation:v1';
const LAST_START_EPOCH_STORAGE_KEY = 'container-usage:last-start-epoch:v1';
const START_ADMISSION_STORAGE_KEY = 'container-usage:start-admission:v1';
const BILLING_BLOCK_STORAGE_KEY = 'container-usage:budget-block:v1';
const BILLING_FORCE_STOP_SECONDS = 120;

// oxlint-disable-next-line no-empty-object-type -- Matches the Sandbox 0.12.1 constructor.
type SandboxDurableObjectState = DurableObjectState<{}>;
type ContainerStopParams = { reason: 'exit' | 'runtime_signal'; exitCode?: number };

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

const startAdmissionSchema = z
  .object({
    generation: z.uuid(),
    billingMode: z.enum(['shadow', 'paid']),
    remainingMicrodollars: z.number().int().optional(),
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

function usageServiceForSandboxClass(sandboxClassName: SandboxClassName): string {
  const suffix = sandboxClassName.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  return `${SERVICE}-${suffix}`;
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

export abstract class MeteredSandbox extends StockSandbox<Env> {
  protected abstract get sandboxClassName(): SandboxClassName;

  private readonly usageClient: ContainerUsageClient;
  private readonly billingHeartbeat: BillingHeartbeatController;
  private billingLifecycleTail: Promise<void> = Promise.resolve();
  private activityExpiryRequested = false;

  constructor(ctx: SandboxDurableObjectState, env: Env) {
    super(ctx, env);
    this.usageClient = this.createUsageClient(env);
    this.billingHeartbeat = installBillingHeartbeat(this, {
      client: this.usageClient,
      storage: this.ctx.storage,
      stopOnStoppedState: false,
      beforeHeartbeatDelivery: context => this.ensureStartAcknowledged(context),
      beforeStopDelivery: context => this.ensureStartAcknowledged(context),
      onGenerationClosed: () => this.schedulePendingGenerationIfRunning(),
      onBudgetWarning: budget => this.logBudgetWarning(budget),
      enforceBudgetStop: (budget, expected) => this.enforceBudgetStop(budget, expected),
    });
  }

  private createUsageClient(env: Env): ContainerUsageClient {
    return createContainerUsageClient(env.CONTAINER_USAGE_METER, {
      service: usageServiceForSandboxClass(this.sandboxClassName),
    });
  }

  /**
   * Whether this sandbox's container is currently running.
   *
   * Reads Durable Object state only. Calling this over RPC does not boot a sleeping
   * container, unlike any container fetch, so callers can confirm "nothing is running
   * in there" without paying for a wake-up.
   */
  async isContainerRunning(): Promise<boolean> {
    return this.ctx.container?.running === true;
  }

  async isBillingBlocked(): Promise<boolean> {
    return (await this.getBillingBlock()) !== undefined;
  }

  async ensureBillingAdmission(input: unknown): Promise<SandboxBillingAdmissionResult> {
    const parsed = parseSandboxBillingInput(input);
    assertSandboxBillingAllocation(this.sandboxClassName, parsed);
    return this.runBillingExclusive(async () => {
      await this.ctx.storage.put(PENDING_ATTRIBUTION_STORAGE_KEY, parsed);
      const block = await this.getBillingBlock();
      let active = await getBillingContext(this.ctx.storage);

      if (!block && !parsed.enforcementRequested) {
        return { success: true, billingMode: 'shadow' };
      }

      if (active && !active.measurementStarted && !block) {
        const admission = await this.getStartAdmission(active.generation);
        if (admission) {
          if (parsed.enforcementRequested && admission.billingMode !== 'paid') {
            return {
              success: false,
              code: 'configuration_mismatch',
              message: 'Container billing rollout is not enabled in the usage meter',
            };
          }
          return {
            success: true,
            billingMode: admission.billingMode,
            ...(admission.remainingMicrodollars === undefined
              ? {}
              : { remainingMicrodollars: admission.remainingMicrodollars }),
          };
        }
      }

      if (active?.measurementStarted && this.ctx.container?.running === true) {
        const admission = await this.getStartAdmission(active.generation);
        if (block) {
          return {
            success: false,
            code: 'stopping',
            message: 'Container is stopping because its billing balance is too low',
            remainingMicrodollars: block.remainingMicrodollars,
          };
        }
        if (parsed.enforcementRequested && admission?.billingMode !== 'paid') {
          return {
            success: false,
            code: 'configuration_mismatch',
            message: 'Container billing rollout is not enabled for the active usage generation',
          };
        }
        return admission
          ? {
              success: true,
              billingMode: admission.billingMode,
              remainingMicrodollars: admission.remainingMicrodollars,
            }
          : { success: true, billingMode: 'shadow' };
      }

      if (this.ctx.container?.running === true) {
        return {
          success: false,
          code: 'stopping',
          message: 'Container billing admission is waiting for the previous run to stop',
        };
      }

      if (active) {
        try {
          await this.billingHeartbeat.recordStop(
            { reason: 'runtime_signal' },
            active.stoppedObservedAtMs ?? Date.now()
          );
          await this.ctx.storage.delete(START_ACK_GENERATION_STORAGE_KEY);
          await this.ctx.storage.delete(START_ADMISSION_STORAGE_KEY);
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

      const context = await this.createBillingGeneration(parsed, 'attribution-adoption');
      let result;
      try {
        result = await this.usageClient.recordStartV2(startInputFromContext(context));
      } catch (error) {
        await clearBillingContext(this.ctx.storage);
        return {
          success: false,
          code: 'meter_unavailable',
          message:
            error instanceof Error ? error.message : 'Container billing meter is unavailable',
        };
      }
      if (!result.success) {
        await clearBillingContext(this.ctx.storage);
        return {
          success: false,
          code:
            result.error.code === 'insufficient_credits'
              ? 'insufficient_credits'
              : 'configuration_mismatch',
          message: result.error.message,
          ...(result.error.code === 'insufficient_credits'
            ? {
                remainingMicrodollars: result.error.remainingMicrodollars,
                minimumRequiredMicrodollars: result.error.minimumRequiredMicrodollars,
              }
            : {}),
        };
      }
      if (parsed.enforcementRequested && result.billingMode !== 'paid') {
        await clearBillingContext(this.ctx.storage);
        return {
          success: false,
          code: 'configuration_mismatch',
          message: 'Container billing rollout is not enabled in the usage meter',
        };
      }
      await this.ctx.storage.put(START_ACK_GENERATION_STORAGE_KEY, context.generation);
      await this.ctx.storage.put(START_ADMISSION_STORAGE_KEY, {
        generation: context.generation,
        billingMode: result.billingMode,
        ...(result.billingMode === 'paid'
          ? { remainingMicrodollars: result.remainingMicrodollars }
          : {}),
      });
      await this.ctx.storage.delete(BILLING_BLOCK_STORAGE_KEY);
      return result.billingMode === 'paid'
        ? {
            success: true,
            billingMode: 'paid',
            remainingMicrodollars: result.remainingMicrodollars,
          }
        : { success: true, billingMode: 'shadow' };
    });
  }

  async configureBilling(input: unknown): Promise<void> {
    const parsed = parseSandboxBillingInput(input);
    assertSandboxBillingAllocation(this.sandboxClassName, parsed);
    await this.runBillingExclusive(async () => {
      await this.ctx.storage.put(PENDING_ATTRIBUTION_STORAGE_KEY, parsed);
      let active = await getBillingContext(this.ctx.storage);
      if (active?.pendingStop) {
        try {
          await this.billingHeartbeat.recordStop(active.pendingStop);
          await this.ctx.storage.delete(START_ACK_GENERATION_STORAGE_KEY);
        } catch (error) {
          await this.deferBillingDelivery(error, 'pending stop recovery');
          return;
        }
        active = undefined;
      }
      if (active?.measurementStarted) {
        if (this.ctx.container?.running === true) {
          try {
            await this.ensureStartAcknowledged(active);
          } catch (error) {
            await this.deferBillingDelivery(error, 'active start acknowledgement');
          }
          return;
        }
        const state = await this.getState();
        const stoppedAtMs = active.stoppedObservedAtMs ?? stoppedAtFromState(state);
        try {
          await this.billingHeartbeat.recordStop(
            {
              reason: 'runtime_signal',
              ...(state.status === 'stopped_with_code' && state.exitCode !== undefined
                ? { exitCode: state.exitCode }
                : {}),
            },
            stoppedAtMs
          );
          await this.ctx.storage.delete(START_ACK_GENERATION_STORAGE_KEY);
        } catch (error) {
          await this.deferBillingDelivery(error, 'missed stop recovery');
          return;
        }
        active = undefined;
      }

      // A start may have succeeded before the DO was evicted or a prior admission response failed.
      // Retry the same idempotent start before allowing work to use that running generation.
      if (active) {
        const state = await this.getState();
        if (state.status !== 'stopped' && state.status !== 'stopped_with_code') {
          await this.admitAndScheduleBestEffort(active);
          return;
        }
        const stoppedAtMs = active.stoppedObservedAtMs ?? stoppedAtFromState(state);
        try {
          await this.billingHeartbeat.recordStop(
            {
              reason: 'runtime_signal',
              ...(state.status === 'stopped_with_code' && state.exitCode !== undefined
                ? { exitCode: state.exitCode }
                : {}),
            },
            stoppedAtMs
          );
          await this.ctx.storage.delete(START_ACK_GENERATION_STORAGE_KEY);
        } catch (error) {
          await this.deferBillingDelivery(error, 'unmeasured stop recovery');
          return;
        }
      }

      // Adopt containers that were already running when shadow metering rolled out.
      if (this.ctx.container?.running === true) {
        await this.startBillingGeneration(parsed, 'attribution-adoption');
      }
    });
  }

  override async onStart(): Promise<void> {
    await super.onStart();
    this.runShadowTask('start lifecycle', async () => {
      const block = await this.getBillingBlock();
      if (block) {
        await this.scheduleForceStop(block);
        await this.stop();
        return;
      }
      const previous = await getBillingContext(this.ctx.storage);
      if (previous) {
        if (previous.pendingStop) {
          try {
            await this.billingHeartbeat.recordStop(previous.pendingStop);
            await this.ctx.storage.delete(START_ACK_GENERATION_STORAGE_KEY);
          } catch (error) {
            await this.deferBillingDelivery(error, 'start blocked by pending stop');
            return;
          }
        } else if (!previous.measurementStarted) {
          await this.admitAndScheduleBestEffort(previous);
          return;
        } else {
          // The SDK can dispatch onStart more than once for concurrent callers waiting on one
          // physical start. Existing measured state is therefore already the current generation.
          try {
            await this.ensureStartAcknowledged(previous);
          } catch (error) {
            await this.deferBillingDelivery(error, 'duplicate start acknowledgement');
          }
          return;
        }
      }

      const input = await this.getPendingAttribution();
      if (!input) {
        logger
          .withFields({ sandboxClass: this.sandboxClassName })
          .warn('Container usage shadow start has no attribution');
        return;
      }

      await this.startBillingGeneration(input, 'container-start');
    });
  }

  override async onStop(params?: ContainerStopParams): Promise<void> {
    const stoppedAtMs = Date.now();
    await super.onStop();
    const activityExpiryRequested = this.activityExpiryRequested;
    this.activityExpiryRequested = false;
    this.runShadowTask('stop lifecycle', async () => {
      const context = await getBillingContext(this.ctx.storage);
      if (!context) return;
      const requestedReason = activityExpiryRequested
        ? 'activity_expired'
        : await this.getPendingStopReason(context.generation);
      // Pairs with `container_started`: reason plus lifetime makes idle-expiry patterns
      // queryable in logs instead of only in the usage tables.
      logger
        .withTags({ logTag: 'container_stopped', sandboxId: context.instanceId })
        .withFields({
          sandboxClass: this.sandboxClassName,
          generation: context.generation,
          startEpochMs: context.startEpochMs,
          reason: requestedReason ?? params?.reason ?? 'runtime_signal',
          exitCode: params?.exitCode,
          lifetimeMs: stoppedAtMs - context.startEpochMs,
          sessionId: context.sessionId,
        })
        .info('Container stopped');
      const pending = await this.billingHeartbeat.persistStop(
        {
          reason: requestedReason ?? params?.reason ?? 'runtime_signal',
          exitCode: params?.exitCode,
        },
        stoppedAtMs
      );
      if (!pending) return;
      await this.ensureStartAcknowledged(pending);
      await this.billingHeartbeat.recordStop({
        reason: requestedReason ?? params?.reason ?? 'runtime_signal',
        exitCode: params?.exitCode,
      });
      await this.ctx.storage.delete(START_ACK_GENERATION_STORAGE_KEY);
      await this.ctx.storage.delete(PENDING_STOP_REASON_STORAGE_KEY);
    });
  }

  override async onActivityExpired(): Promise<void> {
    this.activityExpiryRequested = true;
    await super.onActivityExpired();
    this.runShadowTask('activity expiry', async () => {
      const context = await getBillingContext(this.ctx.storage);
      if (context) {
        await this.ctx.storage.put(PENDING_STOP_REASON_STORAGE_KEY, {
          generation: context.generation,
          reason: 'activity_expired',
        });
      }
    });
  }

  override async destroy(): Promise<void> {
    const block = await this.getBillingBlock();
    await super.destroy();
    if (block) await this.ctx.storage.put(BILLING_BLOCK_STORAGE_KEY, block);
  }

  private runBillingExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.billingLifecycleTail.then(operation, operation);
    this.billingLifecycleTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private runShadowTask(operation: string, task: () => Promise<void>): void {
    const promise = this.runBillingExclusive(task).catch(error => {
      this.logShadowFailure(error, operation);
    });
    this.ctx.waitUntil(promise);
  }

  private schedulePendingGenerationIfRunning(): void {
    this.runShadowTask('replacement generation', async () => {
      if (await this.getBillingBlock()) return;
      if (this.ctx.container?.running !== true) return;
      if (await getBillingContext(this.ctx.storage)) return;
      const input = await this.getPendingAttribution();
      if (input) await this.startBillingGeneration(input, 'replacement-generation');
    });
  }

  private async getPendingAttribution(): Promise<SandboxBillingInput | undefined> {
    const stored = await this.ctx.storage.get(PENDING_ATTRIBUTION_STORAGE_KEY);
    return stored === undefined ? undefined : parseSandboxBillingInput(stored);
  }

  private async getPendingStopReason(generation: string): Promise<'activity_expired' | undefined> {
    const stored = await this.ctx.storage.get(PENDING_STOP_REASON_STORAGE_KEY);
    if (stored === undefined) return undefined;
    const parsed = pendingStopReasonSchema.parse(stored);
    return parsed.generation === generation ? parsed.reason : undefined;
  }

  private async admitAndScheduleBestEffort(context: BillingContext): Promise<void> {
    try {
      await this.ensureStartAcknowledged(context);
    } catch (error) {
      await this.deferBillingDelivery(error, 'start acknowledgement');
      return;
    }
    try {
      await this.billingHeartbeat.scheduleHeartbeat();
    } catch (error) {
      await this.deferBillingDelivery(error, 'heartbeat scheduling', false);
    }
  }

  private async deferBillingDelivery(
    error: unknown,
    operation: string,
    scheduleRetry = true
  ): Promise<void> {
    if (scheduleRetry) {
      try {
        await this.billingHeartbeat.scheduleHeartbeat();
      } catch {
        // A later sandbox acquisition retries persisted shadow state.
      }
    }
    this.logShadowFailure(error, operation);
  }

  private logShadowFailure(error: unknown, operation: string): void {
    logger
      .withFields({
        error: error instanceof Error ? error.message : String(error),
        operation,
        sandboxClass: this.sandboxClassName,
      })
      .warn('Container usage shadow delivery deferred');
  }

  private async ensureStartAcknowledged(context: BillingContext): Promise<void> {
    const acknowledgedGeneration = await this.ctx.storage.get<string>(
      START_ACK_GENERATION_STORAGE_KEY
    );
    if (acknowledgedGeneration !== context.generation) {
      await this.usageClient.recordStart(startInputFromContext(context));
      await this.ctx.storage.put(START_ACK_GENERATION_STORAGE_KEY, context.generation);
    }
  }

  private async getStartAdmission(generation: string) {
    const stored = await this.ctx.storage.get(START_ADMISSION_STORAGE_KEY);
    if (stored === undefined) return undefined;
    const parsed = startAdmissionSchema.parse(stored);
    return parsed.generation === generation ? parsed : undefined;
  }

  private async getBillingBlock() {
    const stored = await this.ctx.storage.get(BILLING_BLOCK_STORAGE_KEY);
    return stored === undefined ? undefined : billingBlockSchema.parse(stored);
  }

  private async logBudgetWarning(budget: {
    verdict: string;
    remainingMicrodollars?: number;
  }): Promise<void> {
    const context = await getBillingContext(this.ctx.storage);
    logger
      .withTags({ logTag: 'container_billing_warning' })
      .withFields({
        sandboxClass: this.sandboxClassName,
        billingMode: 'paid',
        verdict: budget.verdict,
        remainingMicrodollars: budget.remainingMicrodollars,
        generation: context?.generation,
        subjectType: context?.subject.type,
        sessionId: context?.sessionId,
      })
      .warn('Container billing balance is approaching the stop threshold');
  }

  private async scheduleForceStop(block: z.infer<typeof billingBlockSchema>): Promise<void> {
    const delaySeconds = Math.max(0, Math.ceil((block.forceStopAt - Date.now()) / 1_000));
    this.deleteSchedules('billingForceStop');
    await this.schedule(delaySeconds, 'billingForceStop', block.generation);
  }

  private async enforceBudgetStop(
    budget: { verdict: string; remainingMicrodollars?: number },
    expected: { generation: string; startEpochMs: number }
  ): Promise<void> {
    const now = Date.now();
    const block = {
      generation: expected.generation,
      startEpochMs: expected.startEpochMs,
      blockedAt: now,
      forceStopAt: now + BILLING_FORCE_STOP_SECONDS * 1_000,
      remainingMicrodollars: budget.remainingMicrodollars,
    };
    await this.ctx.storage.put(BILLING_BLOCK_STORAGE_KEY, block);
    await this.scheduleForceStop(block);
    logger
      .withTags({ logTag: 'container_billing_stop' })
      .withFields({
        sandboxClass: this.sandboxClassName,
        generation: expected.generation,
        remainingMicrodollars: budget.remainingMicrodollars,
        forceStopAt: block.forceStopAt,
      })
      .warn('Container billing stop initiated');
    await this.stop();
  }

  async billingForceStop(generation: string): Promise<void> {
    const block = await this.getBillingBlock();
    if (!block || block.generation !== generation || this.ctx.container?.running !== true) return;
    logger
      .withTags({ logTag: 'container_billing_force_stop' })
      .withFields({
        sandboxClass: this.sandboxClassName,
        generation,
        stopLatencyMs: Date.now() - block.blockedAt,
      })
      .error('Force-destroying container after billing stop deadline');
    await this.destroy();
  }

  private async createBillingGeneration(
    input: SandboxBillingInput,
    trigger: ContainerStartTrigger
  ): Promise<BillingContext> {
    const capacity = SANDBOX_CAPACITIES[this.sandboxClassName];
    const previousStartEpochMs =
      (await this.ctx.storage.get<number>(LAST_START_EPOCH_STORAGE_KEY)) ?? -1;
    const startEpochMs = Math.max(Date.now(), previousStartEpochMs + 1);
    await this.ctx.storage.put(LAST_START_EPOCH_STORAGE_KEY, startEpochMs);
    const context = await setBillingContext(this.ctx.storage, {
      subject: input.subject,
      actor: input.actor,
      ...(input.onBehalfOf ? { onBehalfOf: input.onBehalfOf } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      service: usageServiceForSandboxClass(this.sandboxClassName),
      instanceId: input.sandboxId,
      sku: SANDBOX_USAGE_SKUS[this.sandboxClassName],
      metadata: {
        container_class: this.sandboxClassName,
        durable_object_id: this.ctx.id.toString(),
        vcpu: String(capacity.vcpu),
        memory_mib: String(capacity.memoryMiB),
        disk_mb: String(capacity.diskMB),
        ...(input.metadata?.origin ? { origin: input.metadata.origin } : {}),
      },
      startEpochMs,
    } satisfies UsageContext & { startEpochMs: number });
    await this.ctx.storage.delete(PENDING_STOP_REASON_STORAGE_KEY);
    logger
      .withTags({ logTag: 'container_started', sandboxId: input.sandboxId })
      .withFields({
        sandboxClass: this.sandboxClassName,
        generation: context.generation,
        startEpochMs,
        trigger,
        sessionId: input.sessionId,
        durableObjectId: this.ctx.id.toString(),
      })
      .info('Container billing generation created');
    return context;
  }

  private async startBillingGeneration(
    input: SandboxBillingInput,
    trigger: ContainerStartTrigger
  ): Promise<void> {
    const context = await this.createBillingGeneration(input, trigger);
    await this.admitAndScheduleBestEffort(context);
  }
}
