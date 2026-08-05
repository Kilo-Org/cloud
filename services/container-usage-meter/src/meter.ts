import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  heartbeatIdempotencyKey,
  intervalId,
  recordHeartbeatInputSchema,
  recordStartInputSchema,
  recordStopInputSchema,
  startIdempotencyKey,
  stopIdempotencyKey,
  usageContextFingerprint,
  type ContainerUsageRpcMethods,
  type HeartbeatAck,
  type RecordAck,
  type RecordHeartbeatInput,
  type RecordStartInput,
  type RecordStartResult,
  type RecordStopInput,
  type UsageContext,
} from '@kilocode/container-usage';
import { applyHeartbeat, applyStart, applyStop } from './postgres';
import { billingConfigFromEnv } from './billing-config';

function assertContextMatches(
  input: RecordHeartbeatInput | RecordStopInput,
  context: UsageContext
): void {
  if (context.service !== input.service || context.instanceId !== input.instanceId) {
    throw new Error('Usage context must match the interval identity');
  }
}

function assertIdempotencyKey(actual: string, expected: string): void {
  if (actual !== expected) throw new Error('Invalid container usage idempotency key');
}

function copyUsageContext(context: UsageContext): UsageContext {
  return {
    service: context.service,
    instanceId: context.instanceId,
    sku: context.sku,
    subject: context.subject,
    actor: context.actor,
    onBehalfOf: context.onBehalfOf,
    sessionId: context.sessionId,
    metadata: context.metadata,
  };
}

type MeterOperation = 'start' | 'heartbeat' | 'stop';

function logRpcOutcome(
  operation: MeterOperation,
  service: string,
  outcome: 'accepted' | 'rejected' | 'failed',
  details: { dedup?: boolean; rejectionCode?: string; errorName?: string } = {}
): void {
  console.log(
    JSON.stringify({
      message: 'Container usage meter RPC completed',
      event: 'container_usage_rpc',
      operation,
      service,
      outcome,
      ...details,
    })
  );
}

export class ContainerUsageMeter
  extends WorkerEntrypoint<Cloudflare.Env>
  implements ContainerUsageRpcMethods
{
  async recordStart(input: RecordStartInput): Promise<RecordStartResult> {
    const parsed = recordStartInputSchema.parse(input);
    assertIdempotencyKey(
      parsed.idempotencyKey,
      startIdempotencyKey(parsed.service, parsed.instanceId, parsed.startEpochMs)
    );
    const context = copyUsageContext(parsed);
    const id = intervalId(parsed.service, parsed.instanceId, parsed.startEpochMs);
    let result: Awaited<ReturnType<typeof applyStart>>;
    try {
      result = await applyStart(
        this.env,
        parsed,
        id,
        await usageContextFingerprint(context),
        Date.now(),
        billingConfigFromEnv(this.env)
      );
    } catch (error) {
      logRpcOutcome('start', parsed.service, 'failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      throw error;
    }
    switch (result.kind) {
      case 'rejected':
        logRpcOutcome('start', parsed.service, 'rejected', { rejectionCode: result.code });
        return { success: false, error: { code: result.code, message: result.message } };
      case 'applied':
        logRpcOutcome('start', parsed.service, 'accepted', { dedup: result.dedup });
        return {
          success: true,
          ack: { intervalId: id, durable: 'pg', dedup: result.dedup },
        };
    }
  }

  async recordHeartbeat(input: RecordHeartbeatInput): Promise<HeartbeatAck> {
    const parsed = recordHeartbeatInputSchema.parse(input);
    assertContextMatches(parsed, parsed.context);
    assertIdempotencyKey(
      parsed.idempotencyKey,
      heartbeatIdempotencyKey(parsed.service, parsed.instanceId, parsed.startEpochMs, parsed.seq)
    );
    const id = intervalId(parsed.service, parsed.instanceId, parsed.startEpochMs);
    let result: Awaited<ReturnType<typeof applyHeartbeat>>;
    try {
      result = await applyHeartbeat(
        this.env,
        parsed,
        id,
        await usageContextFingerprint(parsed.context),
        Date.now(),
        billingConfigFromEnv(this.env)
      );
    } catch (error) {
      logRpcOutcome('heartbeat', parsed.service, 'failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      throw error;
    }
    logRpcOutcome('heartbeat', parsed.service, 'accepted', { dedup: result.dedup });
    return {
      intervalId: id,
      durable: 'pg',
      dedup: result.dedup,
      billingMode: result.billingMode,
      budget: result.budget,
    };
  }

  async recordStop(input: RecordStopInput): Promise<RecordAck> {
    const parsed = recordStopInputSchema.parse(input);
    assertContextMatches(parsed, parsed.context);
    assertIdempotencyKey(
      parsed.idempotencyKey,
      stopIdempotencyKey(parsed.service, parsed.instanceId, parsed.startEpochMs)
    );
    const id = intervalId(parsed.service, parsed.instanceId, parsed.startEpochMs);
    let result: Awaited<ReturnType<typeof applyStop>>;
    try {
      result = await applyStop(
        this.env,
        parsed,
        id,
        await usageContextFingerprint(parsed.context),
        Date.now(),
        billingConfigFromEnv(this.env)
      );
    } catch (error) {
      logRpcOutcome('stop', parsed.service, 'failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      throw error;
    }
    logRpcOutcome('stop', parsed.service, 'accepted', { dedup: result.dedup });
    return { intervalId: id, durable: 'pg', dedup: result.dedup };
  }
}
