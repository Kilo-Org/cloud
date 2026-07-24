import {
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
  SANDBOX_USAGE_SKUS,
  type SandboxBillingInput,
  type SandboxClassName,
} from './container-usage-context.js';

const SERVICE = 'cloud-agent-next';
const PENDING_ATTRIBUTION_STORAGE_KEY = 'container-usage:pending-attribution:v1';
const PENDING_STOP_REASON_STORAGE_KEY = 'container-usage:pending-stop-reason:v1';
const START_ACK_GENERATION_STORAGE_KEY = 'container-usage:start-ack-generation:v1';
const LAST_START_EPOCH_STORAGE_KEY = 'container-usage:last-start-epoch:v1';

// oxlint-disable-next-line no-empty-object-type -- Matches the Sandbox 0.12.1 constructor.
type SandboxDurableObjectState = DurableObjectState<{}>;
type ContainerStopParams = { reason: 'exit' | 'runtime_signal'; exitCode?: number };

const pendingStopReasonSchema = z
  .object({
    generation: z.uuid(),
    reason: z.literal('activity_expired'),
  })
  .strict();

function startInputFromContext(context: BillingContext): ClientRecordStartInput {
  const { service: _service, ...usage } = usageContextFromBillingContext(context);
  return { ...usage, startEpochMs: context.startEpochMs };
}

export abstract class MeteredSandbox extends StockSandbox<Env> {
  protected abstract readonly sandboxClassName: SandboxClassName;

  private readonly usageClient: ContainerUsageClient;
  private readonly billingHeartbeat: BillingHeartbeatController;
  private billingLifecycleTail: Promise<void> = Promise.resolve();
  private activityExpiryRequested = false;

  constructor(ctx: SandboxDurableObjectState, env: Env) {
    super(ctx, env);
    this.usageClient = createContainerUsageClient(env.CONTAINER_USAGE_METER, {
      service: SERVICE,
    });
    this.billingHeartbeat = installBillingHeartbeat(this, {
      client: this.usageClient,
      storage: this.ctx.storage,
      stopOnStoppedState: false,
      beforeHeartbeatDelivery: context => this.ensureStartAcknowledged(context),
      beforeStopDelivery: context => this.ensureStartAcknowledged(context),
      // The meter currently returns only `continue`; shadow mode must not enforce future verdicts.
      enforceBudgetStop: async () => {
        throw new Error('Container budget enforcement is disabled in shadow mode');
      },
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
        try {
          await this.billingHeartbeat.recordStop(
            {
              reason: 'runtime_signal',
              ...(state.status === 'stopped_with_code' && state.exitCode !== undefined
                ? { exitCode: state.exitCode }
                : {}),
            },
            active.stoppedObservedAtMs
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
        try {
          await this.billingHeartbeat.recordStop(
            {
              reason: 'runtime_signal',
              ...(state.status === 'stopped_with_code' && state.exitCode !== undefined
                ? { exitCode: state.exitCode }
                : {}),
            },
            active.stoppedObservedAtMs
          );
          await this.ctx.storage.delete(START_ACK_GENERATION_STORAGE_KEY);
        } catch (error) {
          await this.deferBillingDelivery(error, 'unmeasured stop recovery');
        }
      }

      // Adopt containers that were already running when shadow metering rolled out.
      if (this.ctx.container?.running === true) {
        await this.startBillingGeneration(parsed);
      }
    });
  }

  override async onStart(): Promise<void> {
    await super.onStart();
    this.runShadowTask('start lifecycle', async () => {
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

      await this.startBillingGeneration(input);
    });
  }

  override async onStop(params?: ContainerStopParams): Promise<void> {
    await super.onStop();
    this.runShadowTask('stop lifecycle', async () => {
      const context = await getBillingContext(this.ctx.storage);
      if (!context) return;
      const requestedReason = this.activityExpiryRequested
        ? 'activity_expired'
        : await this.getPendingStopReason(context.generation);
      const pending = await this.billingHeartbeat.persistStop({
        reason: requestedReason ?? params?.reason ?? 'runtime_signal',
        exitCode: params?.exitCode,
      });
      if (!pending) return;
      await this.ensureStartAcknowledged(pending);
      await this.billingHeartbeat.recordStop({
        reason: requestedReason ?? params?.reason ?? 'runtime_signal',
        exitCode: params?.exitCode,
      });
      await this.ctx.storage.delete(START_ACK_GENERATION_STORAGE_KEY);
      await this.ctx.storage.delete(PENDING_STOP_REASON_STORAGE_KEY);
      this.activityExpiryRequested = false;
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

  private async startBillingGeneration(input: SandboxBillingInput): Promise<void> {
    const previousStartEpochMs =
      (await this.ctx.storage.get<number>(LAST_START_EPOCH_STORAGE_KEY)) ?? -1;
    const startEpochMs = Math.max(Date.now(), previousStartEpochMs + 1);
    await this.ctx.storage.put(LAST_START_EPOCH_STORAGE_KEY, startEpochMs);
    const context = await setBillingContext(this.ctx.storage, {
      subject: input.subject,
      actor: input.actor,
      ...(input.onBehalfOf ? { onBehalfOf: input.onBehalfOf } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      service: SERVICE,
      instanceId: input.sandboxId,
      sku: SANDBOX_USAGE_SKUS[this.sandboxClassName],
      metadata: {
        container_class: this.sandboxClassName,
        durable_object_id: this.ctx.id.toString(),
        ...(input.metadata?.origin ? { origin: input.metadata.origin } : {}),
      },
      startEpochMs,
    } satisfies UsageContext & { startEpochMs: number });
    await this.ctx.storage.delete(PENDING_STOP_REASON_STORAGE_KEY);
    await this.admitAndScheduleBestEffort(context);
  }
}
