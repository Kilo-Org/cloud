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

  constructor(ctx: SandboxDurableObjectState, env: Env) {
    super(ctx, env);
    this.usageClient = createContainerUsageClient(env.CONTAINER_USAGE_METER, {
      service: SERVICE,
    });
    this.billingHeartbeat = installBillingHeartbeat(this, {
      client: this.usageClient,
      storage: this.ctx.storage,
      stopOnStoppedState: false,
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
        await this.ensureStartAcknowledged(active);
        await this.billingHeartbeat.recordStop(active.pendingStop);
        await this.ctx.storage.delete(START_ACK_GENERATION_STORAGE_KEY);
        active = undefined;
      }
      if (active?.measurementStarted) {
        await this.ensureStartAcknowledged(active);
        return;
      }

      // A start may have succeeded before the DO was evicted or a prior admission response failed.
      // Retry the same idempotent start before allowing work to use that running generation.
      if (active) {
        const state = await this.getState();
        if (state.status !== 'stopped' && state.status !== 'stopped_with_code') {
          await this.admitAndSchedule(active);
          return;
        }
        await this.ensureStartAcknowledged(active);
        await this.billingHeartbeat.recordStop({
          reason: 'runtime_signal',
          ...(state.status === 'stopped_with_code' && state.exitCode !== undefined
            ? { exitCode: state.exitCode }
            : {}),
        });
        await this.ctx.storage.delete(START_ACK_GENERATION_STORAGE_KEY);
      }

      // Adopt containers that were already running when shadow metering rolled out.
      const state = await this.getState();
      if (state.status !== 'stopped' && state.status !== 'stopped_with_code') {
        await this.startBillingGeneration(parsed);
      }
    });
  }

  override async onStart(): Promise<void> {
    await super.onStart();
    await this.runBillingExclusive(async () => {
      const previous = await getBillingContext(this.ctx.storage);
      if (previous) {
        if (previous.pendingStop) {
          await this.billingHeartbeat.recordStop(previous.pendingStop);
          await this.ctx.storage.delete(START_ACK_GENERATION_STORAGE_KEY);
        } else if (!previous.measurementStarted) {
          await this.admitAndSchedule(previous);
          return;
        } else {
          // The SDK can dispatch onStart more than once for concurrent callers waiting on one
          // physical start. Existing measured state is therefore already the current generation.
          await this.ensureStartAcknowledged(previous);
          return;
        }
      }

      const input = await this.getPendingAttribution();
      if (!input) {
        await super.stop();
        throw new Error('Container started without pending billing attribution');
      }

      await this.startBillingGeneration(input);
    });
  }

  override async onStop(params?: ContainerStopParams): Promise<void> {
    try {
      await this.runBillingExclusive(async () => {
        const context = await getBillingContext(this.ctx.storage);
        if (!context) return;
        const requestedReason = await this.getPendingStopReason(context.generation);
        try {
          const pending = await this.billingHeartbeat.persistStop({
            reason: requestedReason ?? params?.reason ?? 'runtime_signal',
            exitCode: params?.exitCode,
          });
          if (!pending) return;
          await this.ensureStartAcknowledged(pending);
          await this.billingHeartbeat.recordStop(
            pending.pendingStop ?? {
              reason: requestedReason ?? params?.reason ?? 'runtime_signal',
              exitCode: params?.exitCode,
            }
          );
          await this.ctx.storage.delete(START_ACK_GENERATION_STORAGE_KEY);
          await this.ctx.storage.delete(PENDING_STOP_REASON_STORAGE_KEY);
        } catch (error) {
          // recordStop persists its intent before delivery. Keep the heartbeat schedule alive so
          // the durable intent retries without blocking the SDK's physical stop transition.
          try {
            await this.billingHeartbeat.scheduleHeartbeat();
          } catch {
            // The persisted stop intent remains recoverable on the next sandbox acquisition.
          }
          logger
            .withFields({
              error: error instanceof Error ? error.message : String(error),
              sandboxClass: this.sandboxClassName,
            })
            .warn('Container usage stop delivery deferred');
        }
      });
    } finally {
      await super.onStop();
    }
  }

  override async onActivityExpired(): Promise<void> {
    await this.runBillingExclusive(async () => {
      const context = await getBillingContext(this.ctx.storage);
      if (context) {
        await this.ctx.storage.put(PENDING_STOP_REASON_STORAGE_KEY, {
          generation: context.generation,
          reason: 'activity_expired',
        });
      }
    });
    await super.onActivityExpired();
  }

  private runBillingExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.billingLifecycleTail.then(operation, operation);
    this.billingLifecycleTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
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

  private async admitAndSchedule(context: BillingContext): Promise<void> {
    await this.ensureStartAcknowledged(context);
    await this.billingHeartbeat.scheduleHeartbeat();
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
      ...input,
      service: SERVICE,
      instanceId: `${this.sandboxClassName}:${this.ctx.id.toString()}`,
      sku: SANDBOX_USAGE_SKUS[this.sandboxClassName],
      metadata: { ...input.metadata, container_class: this.sandboxClassName },
      startEpochMs,
    } satisfies UsageContext & { startEpochMs: number });
    await this.ctx.storage.delete(PENDING_STOP_REASON_STORAGE_KEY);
    await this.admitAndSchedule(context);
  }
}
