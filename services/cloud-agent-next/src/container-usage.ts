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
import type { Env } from './types.js';
import {
  SANDBOX_USAGE_SKUS,
  type SandboxBillingInput,
  type SandboxClassName,
} from './container-usage-context.js';

const SERVICE = 'cloud-agent-next';
const LAST_START_EPOCH_STORAGE_KEY = 'container-usage:last-start-epoch:v1';
// oxlint-disable-next-line no-empty-object-type -- Matches the Sandbox 0.12.1 constructor.
type SandboxDurableObjectState = DurableObjectState<{}>;

function startInputFromContext(context: BillingContext): ClientRecordStartInput {
  const { service: _service, ...usage } = usageContextFromBillingContext(context);
  return { ...usage, startEpochMs: context.startEpochMs };
}

export abstract class MeteredSandbox extends StockSandbox<Env> {
  protected abstract readonly sandboxClassName: SandboxClassName;

  private readonly usageClient: ContainerUsageClient;
  private readonly billingHeartbeat: BillingHeartbeatController;
  private billingAdmissionTail: Promise<void> = Promise.resolve();

  constructor(ctx: SandboxDurableObjectState, env: Env) {
    super(ctx, env);
    this.usageClient = createContainerUsageClient(env.CONTAINER_USAGE_METER, {
      service: SERVICE,
    });
    this.billingHeartbeat = installBillingHeartbeat(this, {
      client: this.usageClient,
      storage: this.ctx.storage,
      // Shadow metering must never stop customer work.
      enforceBudgetStop: async () => {
        throw new Error('Container budget enforcement is disabled in shadow mode');
      },
    });
  }

  async configureBilling(input: SandboxBillingInput): Promise<void> {
    const operation = this.billingAdmissionTail.then(
      () => this.configureBillingExclusive(input),
      () => this.configureBillingExclusive(input)
    );
    this.billingAdmissionTail = operation.then(
      () => undefined,
      () => undefined
    );
    await operation;
  }

  override async onStart(): Promise<void> {
    await super.onStart();
    const context = await getBillingContext(this.ctx.storage);
    if (!context) {
      await super.stop();
      throw new Error('Container started without an admitted billing context');
    }
    await this.usageClient.recordStart(startInputFromContext(context));
    await this.billingHeartbeat.scheduleHeartbeat();
  }

  override async onStop(): Promise<void> {
    try {
      await this.billingHeartbeat.recordStop({ reason: 'runtime_signal' });
    } finally {
      await super.onStop();
    }
  }

  override async onActivityExpired(): Promise<void> {
    try {
      await this.billingHeartbeat.recordStop({ reason: 'activity_expired' });
    } finally {
      await super.onActivityExpired();
    }
  }

  private async configureBillingExclusive(input: SandboxBillingInput): Promise<void> {
    let context = await getBillingContext(this.ctx.storage);
    if (context?.pendingStop) {
      await this.billingHeartbeat.recordStop(context.pendingStop);
      context = undefined;
    } else if (context?.measurementStarted) {
      const state = await this.getState();
      if (state.status === 'stopped' || state.status === 'stopped_with_code') {
        await this.billingHeartbeat.recordStop({
          reason: 'runtime_signal',
          ...(state.status === 'stopped_with_code' && state.exitCode !== undefined
            ? { exitCode: state.exitCode }
            : {}),
        });
        context = undefined;
      }
    }

    const usageContext = {
      service: SERVICE,
      instanceId: `${this.sandboxClassName}:${this.ctx.id.toString()}`,
      sku: SANDBOX_USAGE_SKUS[this.sandboxClassName],
      ...input,
      metadata: { ...input.metadata, container_class: this.sandboxClassName },
    } satisfies UsageContext;

    if (context) {
      context = await setBillingContext(this.ctx.storage, {
        ...usageContext,
        startEpochMs: context.startEpochMs,
      });
    } else {
      const previousStartEpochMs =
        (await this.ctx.storage.get<number>(LAST_START_EPOCH_STORAGE_KEY)) ?? -1;
      const startEpochMs = Math.max(Date.now(), previousStartEpochMs + 1);
      await this.ctx.storage.put(LAST_START_EPOCH_STORAGE_KEY, startEpochMs);
      context = await setBillingContext(this.ctx.storage, { ...usageContext, startEpochMs });
    }

    await this.usageClient.recordStart(startInputFromContext(context));
  }
}
