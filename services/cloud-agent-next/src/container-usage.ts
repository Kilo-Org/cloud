import {
  createContainerUsageClient,
  DEFAULT_BILLING_HEARTBEAT_SECONDS,
  installBillingHeartbeat,
  type BillingContext,
  type ContainerUsageClient,
} from '@kilocode/container-usage';
import { Sandbox as StockSandbox } from '@cloudflare/sandbox';
import type { Env } from './types.js';
import type { SandboxBillingAdmissionResult, SandboxClassName } from './container-usage-context.js';
import {
  MeteredBillingLifecycle,
  usageServiceForSandboxClass,
  type BillingIdentity,
  type ContainerStopParams,
} from './metered-billing-lifecycle.js';

export function billingHeartbeatSeconds(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_BILLING_HEARTBEAT_SECONDS;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : DEFAULT_BILLING_HEARTBEAT_SECONDS;
}

// oxlint-disable-next-line no-empty-object-type -- Matches the Sandbox 0.12.9 constructor.
type SandboxDurableObjectState = DurableObjectState<{}>;

export abstract class MeteredSandbox extends StockSandbox<Env> {
  protected abstract get sandboxClassName(): SandboxClassName;

  private readonly usageClient: ContainerUsageClient;
  private readonly billing: MeteredBillingLifecycle;

  constructor(ctx: SandboxDurableObjectState, env: Env) {
    super(ctx, env);
    this.usageClient = this.createUsageClient(env);
    this.billing = new MeteredBillingLifecycle({
      storage: this.ctx.storage,
      usageClient: this.usageClient,
      schedule: (delaySeconds, callback, payload) => this.schedule(delaySeconds, callback, payload),
      deleteSchedules: callback => this.deleteSchedules(callback),
      getState: () => this.getState(),
      isContainerRunning: () => this.ctx.container?.running === true,
      stopContainer: () => this.stop(),
      destroyContainer: () => this.destroy(),
      durableObjectId: this.ctx.id.toString(),
      waitUntil: promise => this.ctx.waitUntil(promise),
    });
    this.billing.attachHeartbeat(
      installBillingHeartbeat(this, {
        client: this.usageClient,
        storage: this.ctx.storage,
        heartbeatSeconds: billingHeartbeatSeconds(env.CONTAINER_BILLING_HEARTBEAT_SECONDS),
        stopOnStoppedState: false,
        deferBudgetStopFinalSettlement: true,
        beforeHeartbeatDelivery: context => this.billing.ensureStartAcknowledged(context),
        beforeStopDelivery: context => this.billing.ensureStartAcknowledged(context),
        onGenerationClosed: (context, cause) =>
          this.billing.onGenerationClosed(this.billingIdentity, context, cause),
        onBudgetWarning: budget => this.billing.onBudgetWarning(this.billingIdentity, budget),
        enforceBudgetStop: (budget, expected) =>
          this.billing.enforceBudgetStop(this.billingIdentity, budget, expected),
      })
    );
  }

  private get billingIdentity(): BillingIdentity {
    return { sandboxClassName: this.sandboxClassName };
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
    return this.billing.isBillingBlocked();
  }

  async getBillingRuntimeStatus(): Promise<{
    sandboxClassName: SandboxClassName;
    running: boolean;
    blocked: boolean;
    context?: BillingContext;
  }> {
    return this.billing.getBillingRuntimeStatus(this.billingIdentity);
  }

  async ensureBillingAdmission(input: unknown): Promise<SandboxBillingAdmissionResult> {
    return this.billing.ensureBillingAdmission(this.billingIdentity, input);
  }

  async configureBilling(input: unknown): Promise<void> {
    return this.billing.configureBilling(this.billingIdentity, input);
  }

  override async onStart(): Promise<void> {
    return this.billing.onContainerStarted(this.billingIdentity, () => super.onStart());
  }

  override async onStop(params?: ContainerStopParams): Promise<void> {
    return this.billing.onContainerStopped(this.billingIdentity, params, () => super.onStop());
  }

  override async onActivityExpired(): Promise<void> {
    return this.billing.onActivityExpired(this.billingIdentity, () => super.onActivityExpired());
  }

  async forceDestroyForControlPlane(): Promise<void> {
    const container = this.ctx.container;
    if (!container || typeof container.destroy !== 'function') {
      throw new Error('Native container destruction is unavailable');
    }
    await container.destroy();
  }

  override async destroy(): Promise<void> {
    return this.billing.destroyWithBillingRecovery(() => super.destroy());
  }

  async billingForceStop(generation: string): Promise<void> {
    return this.billing.billingForceStop(this.billingIdentity, generation);
  }
}
