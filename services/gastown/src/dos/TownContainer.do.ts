import { Container } from '@cloudflare/containers';
import { ContainerBillingError } from '../billing/ContainerBilling.error';
import {
  getContainerUsageService,
  isGastownBillingEnabled,
  USAGE_HEARTBEAT_INTERVAL_MS,
  type ContainerRunPolicy,
  type GastownBillingStatus,
  type UsageContext,
} from '../billing/container-usage.billing';
import {
  toBillingStatus,
  type OpenUsageInterval,
  type StoredUsageState,
} from '../billing/container-usage-state.billing';

const TC_LOG = '[TownContainer.do]';
const BILLING_CONTEXT_KEY = 'billing:context';
const BILLING_STATE_KEY = 'billing:state';
const RUN_POLICY_KEY = 'container:runPolicy';

/**
 * TownContainer — a Cloudflare Container per town.
 *
 * All agent processes for a town run inside this container via the SDK.
 * The container exposes:
 * - HTTP control server on port 8080 (start/stop/message/status/merge)
 * - WebSocket on /ws that multiplexes events from all agents
 *
 * This DO is intentionally thin. It manages container lifecycle and proxies
 * ALL requests (including WebSocket upgrades) directly to the container via
 * the base Container class's fetch(). No relay, no polling, no buffering.
 *
 * The browser connects via WebSocket through this DO and the connection is
 * passed directly to the container's Bun server, which sends SDK events
 * over that WebSocket in real-time.
 */
export class TownContainerDO extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '10m';

  // Container env vars. Includes infra URLs and any tokens stored via setEnvVar().
  // The Container base class reads this when booting the container.
  envVars: Record<string, string> = {
    ...(this.env.GASTOWN_API_URL ? { GASTOWN_API_URL: this.env.GASTOWN_API_URL } : {}),
    ...(this.env.KILO_API_URL
      ? {
          KILO_API_URL: this.env.KILO_API_URL,
          KILO_OPENROUTER_BASE: `${this.env.KILO_API_URL}/api`,
        }
      : {}),
  };

  constructor(ctx: DurableObjectState<Env>, env: Env) {
    super(ctx, env);
    // Load persisted env vars (like KILOCODE_TOKEN) into envVars
    // so they're available when the container boots.
    void ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<Record<string, string>>('container:envVars');
      if (stored) {
        Object.assign(this.envVars, stored);
      }
    });
  }

  /**
   * Store an env var that will be injected into the container OS environment.
   * Takes effect on the next container boot (or immediately if the container
   * hasn't started yet). Call this from the TownDO during configureRig.
   */
  async setEnvVar(key: string, value: string): Promise<void> {
    const stored = (await this.ctx.storage.get<Record<string, string>>('container:envVars')) ?? {};
    stored[key] = value;
    await this.ctx.storage.put('container:envVars', stored);
    this.envVars[key] = value;
    console.log(`${TC_LOG} setEnvVar: ${key} stored (${value.length} chars)`);
  }

  async deleteEnvVar(key: string): Promise<void> {
    const stored = (await this.ctx.storage.get<Record<string, string>>('container:envVars')) ?? {};
    delete stored[key];
    await this.ctx.storage.put('container:envVars', stored);
    delete this.envVars[key];
    console.log(`${TC_LOG} deleteEnvVar: ${key} removed`);
  }

  async updateRegistry(registry: unknown): Promise<void> {
    await this.ctx.storage.put('container:registry', registry);
    console.log(
      `${TC_LOG} updateRegistry: updated (${Array.isArray(registry) ? registry.length : '?'} entries)`
    );
  }

  async getRegistry(): Promise<unknown> {
    const registry = await this.ctx.storage.get<unknown>('container:registry');
    return registry ?? [];
  }

  override async onStart(): Promise<void> {
    console.log(`${TC_LOG} container started for DO id=${this.ctx.id.toString()}`);
    if ((await this.getRunPolicy()) === 'paused_by_user') {
      await this.stop();
      return;
    }
    if (!isGastownBillingEnabled(this.env)) return;

    try {
      const state = await this.ensureBillingInterval();
      if (state.phase === 'stopping') {
        await this.stop();
      } else if (state.phase === 'starting' && state.startRecorded) {
        await this.ctx.storage.put(BILLING_STATE_KEY, {
          ...state,
          phase: 'running',
          lastReportedAt: Date.now(),
        });
      }
    } catch (error) {
      console.error(`${TC_LOG} failed to open billing interval after container start`, error);
      await this.stop().catch(stopError =>
        console.error(`${TC_LOG} failed to stop unmetered container`, stopError)
      );
    }
  }

  /**
   * Ensure the container runtime has been started. For an already-running
   * container this intentionally does not trust or refresh the SDK health
   * state; TownDO's /health probe is the application-level liveness source.
   *
   * Returns how long startAndWaitForPorts took when this call actually
   * triggered a cold start.
   */
  async warmUp(): Promise<{ coldStart: boolean; durationMs: number }> {
    await this.assertAutomaticStartsEnabled();
    if (isGastownBillingEnabled(this.env)) {
      await this.ensureBillingInterval();
    }
    await this.assertAutomaticStartsEnabled();
    if (this.ctx.container?.running === true) {
      // Runtime-level fast path only. TownDO's /health probe is the
      // application-level liveness source and may still recover a wedged
      // running container.
      return { coldStart: false, durationMs: 0 };
    }
    const t0 = Date.now();
    try {
      await this.startAndWaitForPorts();
    } catch (error) {
      await this.closeBillingInterval('runtime_signal');
      throw error;
    }
    return { coldStart: true, durationMs: Date.now() - t0 };
  }

  override async onStop({ exitCode, reason }: { exitCode: number; reason: string }): Promise<void> {
    console.log(
      `${TC_LOG} container stopped: exitCode=${exitCode} reason=${reason} id=${this.ctx.id.toString()}`
    );
    if (!isGastownBillingEnabled(this.env)) return;

    const current = await this.getUsageState();
    const stopReason =
      current.phase !== 'idle' && current.stopReason
        ? current.stopReason
        : reason.toLowerCase().includes('activity')
          ? 'activity_expired'
          : exitCode === 0
            ? 'exit'
            : 'runtime_signal';
    await this.closeBillingInterval(stopReason);
  }

  override async onActivityExpired(): Promise<void> {
    if (isGastownBillingEnabled(this.env)) {
      const state = await this.getUsageState();
      if (state.phase !== 'idle' && state.phase !== 'stopping') {
        await this.ctx.storage.put(BILLING_STATE_KEY, {
          ...state,
          phase: 'stopping',
          stopReason: 'activity_expired',
        } satisfies OpenUsageInterval);
      }
    }
    await super.onActivityExpired();
  }

  override onError(error: unknown): void {
    console.error(`${TC_LOG} container error:`, error, `id=${this.ctx.id.toString()}`);
  }

  override async fetch(request: Request): Promise<Response> {
    await this.assertAutomaticStartsEnabled();
    if (isGastownBillingEnabled(this.env)) {
      await this.ensureBillingInterval();
    }
    await this.assertAutomaticStartsEnabled();
    return super.fetch(request);
  }

  async setBillingContext(context: UsageContext): Promise<void> {
    await this.ctx.storage.put(BILLING_CONTEXT_KEY, context);
    const state = await this.getUsageState();
    if (state.phase === 'idle') {
      await this.ctx.storage.put(BILLING_STATE_KEY, { ...state, context });
    }
  }

  async getBillingStatus(): Promise<GastownBillingStatus> {
    return toBillingStatus(
      isGastownBillingEnabled(this.env),
      await this.getUsageState(),
      await this.getRunPolicy()
    );
  }

  async recordUsageHeartbeat(): Promise<GastownBillingStatus> {
    if (!isGastownBillingEnabled(this.env)) return this.getBillingStatus();

    let state = await this.getUsageState();
    if (state.phase === 'starting') {
      state = await this.completeBillingStart(state);
    }
    const initialRuntimeState = state.phase === 'idle' ? await this.getState() : null;
    if (
      state.phase === 'idle' &&
      (initialRuntimeState?.status === 'running' || initialRuntimeState?.status === 'healthy')
    ) {
      try {
        state = await this.ensureBillingInterval();
        if (state.phase === 'starting' && state.startRecorded) {
          state = { ...state, phase: 'running' };
          await this.ctx.storage.put(BILLING_STATE_KEY, state);
        }
      } catch (error) {
        if (error instanceof ContainerBillingError && error.code === 'INSUFFICIENT_CREDITS') {
          await this.stopForBilling();
          return this.getBillingStatus();
        }
        throw error;
      }
    }
    const runPolicy = await this.getRunPolicy();
    if (state.phase === 'idle') return toBillingStatus(true, state, runPolicy);
    if (state.phase === 'stopping') {
      const stoppingRuntimeState = await this.getState();
      if (
        stoppingRuntimeState.status === 'running' ||
        stoppingRuntimeState.status === 'healthy' ||
        stoppingRuntimeState.status === 'stopping'
      ) {
        return toBillingStatus(true, state, runPolicy);
      }
      await this.closeBillingInterval(state.stopReason ?? 'runtime_signal');
      return this.getBillingStatus();
    }

    const runtimeState = await this.getState();
    if (runtimeState.status !== 'running' && runtimeState.status !== 'healthy') {
      await this.closeBillingInterval('runtime_signal', state.lastReportedAt);
      return this.getBillingStatus();
    }

    const observedAt = Date.now();
    if (observedAt - state.lastReportedAt < USAGE_HEARTBEAT_INTERVAL_MS) {
      return toBillingStatus(true, state, runPolicy);
    }

    try {
      const updated = await this.captureHeartbeat(state, observedAt);
      return toBillingStatus(true, updated, runPolicy);
    } catch (error) {
      console.error(`${TC_LOG} billing heartbeat failed`, error);
      const status = toBillingStatus(true, state, runPolicy);
      return { ...status, state: 'degraded' };
    }
  }

  async stopForBilling(): Promise<void> {
    if (!isGastownBillingEnabled(this.env)) return;
    const state = await this.getUsageState();
    if (state.phase !== 'idle') {
      if (state.phase !== 'stopping') {
        await this.ctx.storage.put(BILLING_STATE_KEY, {
          ...state,
          phase: 'stopping',
          stopReason: 'runtime_signal',
        } satisfies OpenUsageInterval);
      }
    }
    await this.stop();
  }

  async stopForInactivity(): Promise<void> {
    if (isGastownBillingEnabled(this.env)) {
      const state = await this.getUsageState();
      if (state.phase !== 'idle' && state.phase !== 'stopping') {
        await this.ctx.storage.put(BILLING_STATE_KEY, {
          ...state,
          phase: 'stopping',
          stopReason: 'activity_expired',
        } satisfies OpenUsageInterval);
      }
    }
    await this.stop();
  }

  async setRunPolicy(policy: ContainerRunPolicy): Promise<GastownBillingStatus> {
    await this.ctx.storage.put(RUN_POLICY_KEY, policy);
    if (policy === 'paused_by_user') {
      const state = await this.getUsageState();
      const canCloseBillingInterval =
        state.phase === 'running' || (state.phase === 'starting' && state.startRecorded);
      if (isGastownBillingEnabled(this.env) && canCloseBillingInterval) {
        await this.ctx.storage.put(BILLING_STATE_KEY, {
          ...state,
          phase: 'stopping',
          stopReason: 'runtime_signal',
        } satisfies OpenUsageInterval);
      }
      await this.stop();
    }
    return this.getBillingStatus();
  }

  private async ensureBillingInterval(): Promise<StoredUsageState> {
    await this.assertAutomaticStartsEnabled();
    if (!isGastownBillingEnabled(this.env)) return { phase: 'idle' };

    const existing = await this.getUsageState();
    if (existing.phase === 'running') return existing;
    if (existing.phase === 'stopping') {
      throw new ContainerBillingError(
        'BILLING_UNAVAILABLE',
        'Container billing is still settling the previous runtime'
      );
    }
    if (existing.phase === 'starting') return this.completeBillingStart(existing);

    const context =
      existing.context ?? (await this.ctx.storage.get<UsageContext>(BILLING_CONTEXT_KEY));
    if (!context) {
      throw new ContainerBillingError(
        'BILLING_UNAVAILABLE',
        'Container billing context has not been configured'
      );
    }

    const selected = await this.ctx.storage.transaction(async transaction => {
      const latest = await transaction.get<StoredUsageState>(BILLING_STATE_KEY);
      if (latest && latest.phase !== 'idle') return latest;

      const observedAt = Date.now();
      const starting: OpenUsageInterval = {
        phase: 'starting',
        context: latest?.context ?? context,
        authorizationId: '',
        authorizationKey: `${context.instanceId}:authorize:${observedAt}`,
        startEpochMs: observedAt,
        startRecorded: false,
        seq: 0,
        lastReportedAt: observedAt,
        reportedUsageSeconds: 0,
      };
      await transaction.put(BILLING_STATE_KEY, starting);
      return starting;
    });

    if (selected.phase === 'running') return selected;
    if (selected.phase === 'stopping') {
      throw new ContainerBillingError(
        'BILLING_UNAVAILABLE',
        'Container billing is still settling the previous runtime'
      );
    }
    return this.completeBillingStart(selected);
  }

  private async completeBillingStart(starting: OpenUsageInterval): Promise<OpenUsageInterval> {
    const usage = getContainerUsageService(this.env);
    let current = starting;

    if (
      current.authorizationId &&
      !current.startRecorded &&
      current.authorizationExpiresAt !== undefined &&
      current.authorizationExpiresAt <= Date.now()
    ) {
      const selected = await this.ctx.storage.transaction(async transaction => {
        const latest = await transaction.get<StoredUsageState>(BILLING_STATE_KEY);
        if (!latest || latest.phase !== 'starting') return latest;
        if (
          !latest.authorizationId ||
          latest.startRecorded ||
          latest.authorizationExpiresAt === undefined ||
          latest.authorizationExpiresAt > Date.now()
        ) {
          return latest;
        }

        const observedAt = Date.now();
        const refreshed: OpenUsageInterval = {
          ...latest,
          context: {
            ...latest.context,
            metadata: Object.fromEntries(
              Object.entries(latest.context.metadata).filter(([key]) => key !== 'authorizationId')
            ),
          },
          authorizationId: '',
          authorizationKey: `${latest.context.instanceId}:authorize:${observedAt}`,
          authorizationExpiresAt: undefined,
          startEpochMs: observedAt,
          lastReportedAt: observedAt,
        };
        await transaction.put(BILLING_STATE_KEY, refreshed);
        return refreshed;
      });

      if (!selected || selected.phase === 'idle' || selected.phase === 'stopping') {
        throw new ContainerBillingError(
          'BILLING_UNAVAILABLE',
          'Container billing state changed while refreshing admission'
        );
      }
      current = selected;
    }

    if (!current.authorizationId) {
      let authorization;
      try {
        authorization = await usage.authorizeStart({
          context: current.context,
          idempotencyKey: current.authorizationKey,
          observedAt: current.startEpochMs,
        });
      } catch (error) {
        throw new ContainerBillingError(
          'BILLING_UNAVAILABLE',
          error instanceof Error ? error.message : 'Container billing is unavailable'
        );
      }

      if (authorization.verdict === 'deny') {
        const denied = await this.ctx.storage.transaction(async transaction => {
          const latest = await transaction.get<StoredUsageState>(BILLING_STATE_KEY);
          if (
            !latest ||
            latest.phase !== 'starting' ||
            latest.startEpochMs !== current.startEpochMs ||
            latest.authorizationKey !== current.authorizationKey
          ) {
            return false;
          }
          await transaction.put(BILLING_STATE_KEY, {
            phase: 'idle',
            context: latest.context,
            blocked: true,
            latestBudget: { verdict: 'stop', remaining: authorization.remaining },
          } satisfies StoredUsageState);
          return true;
        });
        if (!denied) {
          throw new ContainerBillingError(
            'BILLING_UNAVAILABLE',
            'Container billing state changed during admission'
          );
        }
        throw new ContainerBillingError(
          'INSUFFICIENT_CREDITS',
          `Gas Town needs at least $${authorization.minimumRequired.toFixed(2)} in credits to start`,
          {
            remaining: authorization.remaining,
            minimumRequired: authorization.minimumRequired,
          }
        );
      }

      const authorized = await this.ctx.storage.transaction(async transaction => {
        const latest = await transaction.get<StoredUsageState>(BILLING_STATE_KEY);
        if (
          !latest ||
          latest.phase !== 'starting' ||
          latest.startEpochMs !== current.startEpochMs ||
          latest.authorizationKey !== current.authorizationKey
        ) {
          return null;
        }
        const updated: OpenUsageInterval = {
          ...latest,
          context: {
            ...latest.context,
            metadata: {
              ...latest.context.metadata,
              authorizationId: authorization.authorizationId,
            },
          },
          authorizationId: authorization.authorizationId,
          authorizationExpiresAt: authorization.expiresAt,
          latestBudget: {
            verdict: 'continue',
            ...(authorization.remaining === undefined
              ? {}
              : { remaining: authorization.remaining }),
          },
          minimumRequired: authorization.minimumRequired,
          ...(authorization.estimatedHourlyCharge === undefined
            ? {}
            : { estimatedHourlyCharge: authorization.estimatedHourlyCharge }),
        };
        await transaction.put(BILLING_STATE_KEY, updated);
        return updated;
      });
      if (!authorized) {
        throw new ContainerBillingError(
          'BILLING_UNAVAILABLE',
          'Container billing state changed during admission'
        );
      }
      current = authorized;
    }

    if (current.startRecorded) return current;

    try {
      await usage.recordStart({
        ...current.context,
        idempotencyKey: `${current.context.instanceId}:start:${current.startEpochMs}`,
        startEpochMs: current.startEpochMs,
        observedAt: current.startEpochMs,
      });
    } catch (error) {
      throw new ContainerBillingError(
        'BILLING_UNAVAILABLE',
        error instanceof Error ? error.message : 'Unable to record container start'
      );
    }

    const recorded = await this.ctx.storage.transaction(async transaction => {
      const latest = await transaction.get<StoredUsageState>(BILLING_STATE_KEY);
      if (
        !latest ||
        latest.phase !== 'starting' ||
        latest.startEpochMs !== current.startEpochMs ||
        latest.authorizationId !== current.authorizationId
      ) {
        return null;
      }
      const updated: OpenUsageInterval = { ...latest, startRecorded: true };
      await transaction.put(BILLING_STATE_KEY, updated);
      return updated;
    });
    if (!recorded) {
      throw new ContainerBillingError(
        'BILLING_UNAVAILABLE',
        'Container billing state changed while recording start'
      );
    }
    return recorded;
  }

  private async captureHeartbeat(
    state: OpenUsageInterval,
    observedAt: number
  ): Promise<StoredUsageState> {
    const selected = await this.ctx.storage.transaction(async transaction => {
      const latest = await transaction.get<StoredUsageState>(BILLING_STATE_KEY);
      if (!latest || latest.phase === 'idle' || latest.startEpochMs !== state.startEpochMs) {
        return null;
      }
      if (latest.pendingHeartbeat) {
        return { interval: latest, pending: latest.pendingHeartbeat };
      }

      const pending = {
        seq: latest.seq + 1,
        observedAt,
        usageSinceLast: Math.max(0, (observedAt - latest.lastReportedAt) / 1000),
        idempotencyKey: `${latest.context.instanceId}:hb:${latest.seq + 1}`,
      } satisfies NonNullable<OpenUsageInterval['pendingHeartbeat']>;
      const interval = { ...latest, pendingHeartbeat: pending } satisfies OpenUsageInterval;
      await transaction.put(BILLING_STATE_KEY, interval);
      return { interval, pending };
    });

    if (!selected) {
      return this.getUsageState();
    }
    const { interval, pending } = selected;

    const ack = await getContainerUsageService(this.env).recordHeartbeat({
      service: 'gastown',
      instanceId: interval.context.instanceId,
      startEpochMs: interval.startEpochMs,
      idempotencyKey: pending.idempotencyKey,
      seq: pending.seq,
      observedAt: pending.observedAt,
      usageSinceLast: pending.usageSinceLast,
      context: interval.context,
    });

    const latest = await this.getUsageState();
    if (latest.phase === 'idle' || latest.startEpochMs !== interval.startEpochMs) return latest;
    if (latest.seq >= pending.seq) return latest;

    const updated: OpenUsageInterval = {
      ...latest,
      phase: latest.phase === 'starting' ? 'running' : latest.phase,
      seq: pending.seq,
      lastReportedAt: pending.observedAt,
      reportedUsageSeconds: (latest.reportedUsageSeconds ?? 0) + pending.usageSinceLast,
      latestBudget: ack.budget,
    };
    delete updated.pendingHeartbeat;
    await this.ctx.storage.put(BILLING_STATE_KEY, updated);
    return updated;
  }

  private async closeBillingInterval(
    reason: 'exit' | 'runtime_signal' | 'activity_expired',
    observedAtOverride?: number
  ): Promise<void> {
    const selected = await this.ctx.storage.transaction(async transaction => {
      const latest = await transaction.get<StoredUsageState>(BILLING_STATE_KEY);
      if (!latest || latest.phase === 'idle') return null;
      if (latest.phase === 'stopping') {
        if (latest.stopObservedAt !== undefined) return latest;
        const stopping = {
          ...latest,
          stopObservedAt: observedAtOverride ?? Date.now(),
        } satisfies OpenUsageInterval;
        await transaction.put(BILLING_STATE_KEY, stopping);
        return stopping;
      }

      const stopping: OpenUsageInterval = {
        ...latest,
        phase: 'stopping',
        stopReason: latest.stopReason ?? reason,
        stopObservedAt: latest.stopObservedAt ?? observedAtOverride ?? Date.now(),
      };
      await transaction.put(BILLING_STATE_KEY, stopping);
      return stopping;
    });
    if (!selected) return;

    const stopReason = selected.stopReason ?? reason;
    const stopObservedAt = selected.stopObservedAt ?? observedAtOverride ?? Date.now();
    let stopping = selected;

    try {
      if (!stopping.finalUsageCaptured && stopObservedAt > stopping.lastReportedAt) {
        const captured = await this.captureHeartbeat(stopping, stopObservedAt);
        if (captured.phase === 'idle') return;
        stopping = captured;
        stopping = {
          ...stopping,
          phase: 'stopping',
          stopReason,
          stopObservedAt,
          finalUsageCaptured: true,
        };
        await this.ctx.storage.put(BILLING_STATE_KEY, stopping);
      }

      await getContainerUsageService(this.env).recordStop({
        service: 'gastown',
        instanceId: stopping.context.instanceId,
        startEpochMs: stopping.startEpochMs,
        idempotencyKey: `${stopping.context.instanceId}:stop:${stopping.startEpochMs}`,
        observedAt: stopObservedAt,
        reason: stopReason,
      });

      const latest = await this.getUsageState();
      if (latest.phase !== 'idle' && latest.startEpochMs === stopping.startEpochMs) {
        const estimatedCharge =
          stopping.estimatedHourlyCharge === undefined
            ? undefined
            : ((stopping.reportedUsageSeconds ?? 0) / 3600) * stopping.estimatedHourlyCharge;
        await this.ctx.storage.put(BILLING_STATE_KEY, {
          phase: 'idle',
          context: stopping.context,
          blocked: stopping.latestBudget?.verdict === 'stop',
          latestBudget: stopping.latestBudget,
          lastRun: {
            startedAt: stopping.startEpochMs,
            stoppedAt: stopObservedAt,
            usageSeconds: stopping.reportedUsageSeconds ?? 0,
            ...(estimatedCharge === undefined ? {} : { estimatedCharge }),
          },
        } satisfies StoredUsageState);
      }
    } catch (error) {
      console.error(`${TC_LOG} failed to close billing interval; will retry`, error);
    }
  }

  private async getUsageState(): Promise<StoredUsageState> {
    return (await this.ctx.storage.get<StoredUsageState>(BILLING_STATE_KEY)) ?? { phase: 'idle' };
  }

  private async getRunPolicy(): Promise<ContainerRunPolicy> {
    return (await this.ctx.storage.get<ContainerRunPolicy>(RUN_POLICY_KEY)) ?? 'automatic';
  }

  private async assertAutomaticStartsEnabled(): Promise<void> {
    if ((await this.getRunPolicy()) === 'paused_by_user') {
      throw new ContainerBillingError(
        'CONTAINER_PAUSED',
        'Automatic starts are paused for this Gas Town'
      );
    }
  }
}

export function getTownContainerStub(env: Env, townId: string) {
  return env.TOWN_CONTAINER.get(env.TOWN_CONTAINER.idFromName(townId));
}

/**
 * Stable Cloudflare identity of a town's container: the TownContainerDO's
 * Durable Object id (hex). This is the id Cloudflare support correlates a
 * container instance by, and the same value TownContainerDO logs in its
 * onStart/onStop/onError callbacks. Deterministic from townId, no I/O.
 */
export function getTownContainerDoId(env: Env, townId: string): string {
  return env.TOWN_CONTAINER.idFromName(townId).toString();
}
