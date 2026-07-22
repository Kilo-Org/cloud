import type { Container } from '@cloudflare/containers';
import type { BudgetVerdict, RecordAck } from './contracts';
import type { ContainerUsageClient } from './client';
import {
  clearBillingContext,
  getBillingContext,
  isSameBillingGeneration,
  updateBillingContext,
  usageContextFromBillingContext,
  type BillingContext,
  type BillingContextStorage,
} from './context';

export const BILLING_HEARTBEAT_CALLBACK = 'billingHeartbeatTick';
export const DEFAULT_BILLING_HEARTBEAT_SECONDS = 5 * 60;

type BillingContainer = Pick<Container, 'deleteSchedules' | 'getState' | 'schedule'>;

export type BillingHeartbeatDependencies = {
  client: ContainerUsageClient;
  storage: BillingContextStorage;
  heartbeatSeconds?: number;
  enforceBudgetStop: (
    budget: BudgetVerdict,
    expected: { generation: string; startEpochMs: number }
  ) => Promise<void>;
  onBudgetWarning?: (budget: BudgetVerdict) => Promise<void> | void;
};

export type BillingHeartbeatController = {
  scheduleHeartbeat: () => Promise<void>;
  billingHeartbeatTick: (generation?: string) => Promise<void>;
  recordStop: (params: {
    reason: 'exit' | 'runtime_signal' | 'activity_expired';
    exitCode?: number;
  }) => Promise<RecordAck | undefined>;
  cancelHeartbeat: () => void;
};

function contextForHeartbeat(context: BillingContext) {
  const { service: _service, ...usage } = usageContextFromBillingContext(context);
  return usage;
}

export function installBillingHeartbeat(
  container: BillingContainer,
  dependencies: BillingHeartbeatDependencies
): BillingHeartbeatController {
  const heartbeatSeconds = dependencies.heartbeatSeconds ?? DEFAULT_BILLING_HEARTBEAT_SECONDS;
  if (heartbeatSeconds <= 0) {
    throw new Error('Billing heartbeat interval must be positive');
  }

  let lifecycleTail: Promise<void> = Promise.resolve();
  const runLifecycleExclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = lifecycleTail.then(operation, operation);
    lifecycleTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };

  const cancelHeartbeat = () => {
    container.deleteSchedules(BILLING_HEARTBEAT_CALLBACK);
  };

  const scheduleHeartbeat = async () => {
    const context = await getBillingContext(dependencies.storage);
    if (!context) {
      cancelHeartbeat();
      return;
    }
    const startedContext = context.measurementStarted
      ? context
      : { ...context, measurementStarted: true, usageMeasuredAtMs: Date.now() };
    if (!context.measurementStarted) {
      await updateBillingContext(dependencies.storage, startedContext);
    }
    cancelHeartbeat();
    await container.schedule(
      heartbeatSeconds,
      BILLING_HEARTBEAT_CALLBACK,
      startedContext.generation
    );
  };

  const rescheduleIfCurrent = async (expected: BillingContext): Promise<boolean> => {
    const current = await getBillingContext(dependencies.storage);
    if (!current || !isSameBillingGeneration(current, expected)) return false;
    cancelHeartbeat();
    await container.schedule(heartbeatSeconds, BILLING_HEARTBEAT_CALLBACK, current.generation);
    return true;
  };

  const recordStopForGeneration = async (
    params: Parameters<BillingHeartbeatController['recordStop']>[0],
    expectedGeneration?: string
  ): Promise<RecordAck | undefined> => {
    let context = await getBillingContext(dependencies.storage);
    if (!context) return undefined;
    if (expectedGeneration !== undefined && context.generation !== expectedGeneration) {
      return undefined;
    }
    if (!context.pendingStop) {
      const pendingHeartbeat = context.pendingHeartbeat;
      const elapsedMs = Math.max(0, Date.now() - context.usageMeasuredAtMs);
      const stopSegment = pendingHeartbeat ?? {
        seq: context.nextSeq,
        usageSinceLast: Math.floor(elapsedMs / 1_000),
        measuredAtMs: context.usageMeasuredAtMs + Math.floor(elapsedMs / 1_000) * 1_000,
      };
      await updateBillingContext(dependencies.storage, {
        ...context,
        pendingStop: { ...params, ...stopSegment },
      });
      const current = await getBillingContext(dependencies.storage);
      if (!current || !isSameBillingGeneration(current, context)) return undefined;
      context = current;
    }
    const stopIntent = context.pendingStop;
    if (!stopIntent) throw new Error('Billing stop intent was not persisted');
    const ack = await dependencies.client.recordStop({
      instanceId: context.instanceId,
      startEpochMs: context.startEpochMs,
      seq: stopIntent.seq,
      usageSinceLast: stopIntent.usageSinceLast,
      reason: stopIntent.reason,
      exitCode: stopIntent.exitCode,
      context: contextForHeartbeat(context),
    });
    const current = await getBillingContext(dependencies.storage);
    if (!current || !isSameBillingGeneration(current, context)) return ack;
    cancelHeartbeat();
    await clearBillingContext(dependencies.storage);
    return ack;
  };

  const recordStop: BillingHeartbeatController['recordStop'] = params =>
    runLifecycleExclusive(() => recordStopForGeneration(params));

  const billingHeartbeatTickForGeneration = async (generation?: string) => {
    let context = await getBillingContext(dependencies.storage);
    if (!context) {
      cancelHeartbeat();
      return;
    }
    if (generation !== undefined && context.generation !== generation) return;
    if (context.pendingStop) {
      try {
        await recordStopForGeneration(context.pendingStop, context.generation);
      } catch (error) {
        await rescheduleIfCurrent(context);
        throw error;
      }
      return;
    }

    let state;
    try {
      state = await container.getState();
    } catch (error) {
      await rescheduleIfCurrent(context);
      throw error;
    }
    const currentAfterState = await getBillingContext(dependencies.storage);
    if (!currentAfterState || !isSameBillingGeneration(currentAfterState, context)) return;
    context = currentAfterState;
    if (state.status === 'stopped' || state.status === 'stopped_with_code') {
      try {
        await recordStopForGeneration(
          {
            reason: 'runtime_signal',
            exitCode: state.status === 'stopped_with_code' ? state.exitCode : undefined,
          },
          context.generation
        );
      } catch (error) {
        await rescheduleIfCurrent(context);
        throw error;
      }
      return;
    }

    if (state.status === 'stopping') {
      await rescheduleIfCurrent(context);
      return;
    }

    const pendingHeartbeat =
      context.pendingHeartbeat ??
      (() => {
        const elapsedMs = Math.max(0, Date.now() - context.usageMeasuredAtMs);
        const usageSinceLast = Math.floor(elapsedMs / 1_000);
        return {
          seq: context.nextSeq,
          usageSinceLast,
          // Advance only by billed whole seconds so subsecond remainder carries
          // into the next heartbeat instead of being rounded away.
          measuredAtMs: context.usageMeasuredAtMs + usageSinceLast * 1_000,
        };
      })();
    if (!context.pendingHeartbeat) {
      await updateBillingContext(dependencies.storage, { ...context, pendingHeartbeat });
    }
    try {
      const ack = await dependencies.client.recordHeartbeat({
        instanceId: context.instanceId,
        startEpochMs: context.startEpochMs,
        seq: pendingHeartbeat.seq,
        usageSinceLast: pendingHeartbeat.usageSinceLast,
        context: contextForHeartbeat(context),
      });
      const current = await getBillingContext(dependencies.storage);
      if (!current || !isSameBillingGeneration(current, context)) return;
      if (
        !current.pendingHeartbeat ||
        current.pendingHeartbeat.seq !== pendingHeartbeat.seq ||
        current.pendingHeartbeat.measuredAtMs !== pendingHeartbeat.measuredAtMs ||
        current.pendingHeartbeat.usageSinceLast !== pendingHeartbeat.usageSinceLast
      ) {
        return;
      }
      await updateBillingContext(dependencies.storage, {
        ...current,
        nextSeq: pendingHeartbeat.seq + 1,
        usageMeasuredAtMs: pendingHeartbeat.measuredAtMs,
        pendingHeartbeat: undefined,
      });

      if (ack.budget.verdict === 'stop') {
        await rescheduleIfCurrent(context);
        await dependencies.enforceBudgetStop(ack.budget, {
          generation: context.generation,
          startEpochMs: context.startEpochMs,
        });
        await recordStopForGeneration({ reason: 'runtime_signal' }, context.generation);
        return;
      }
      if (ack.budget.verdict === 'warn') {
        await dependencies.onBudgetWarning?.(ack.budget);
      }
      await rescheduleIfCurrent(context);
    } catch (error) {
      await rescheduleIfCurrent(context);
      throw error;
    }
  };
  const billingHeartbeatTick = (generation?: string) =>
    runLifecycleExclusive(() => billingHeartbeatTickForGeneration(generation));

  Object.defineProperty(container, BILLING_HEARTBEAT_CALLBACK, {
    configurable: true,
    value: billingHeartbeatTick,
  });

  return { scheduleHeartbeat, billingHeartbeatTick, recordStop, cancelHeartbeat };
}
