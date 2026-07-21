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
import type { FailoverMutation } from './failover-contract';
import { failoverBufferShardName } from './sharding';
import { validateStartSku } from './postgres';

function assertContextMatches(
  input: RecordHeartbeatInput | RecordStopInput,
  context: NonNullable<RecordHeartbeatInput['context']>
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
    region: context.region,
    metadata: context.metadata,
  };
}

export class ContainerUsageMeter
  extends WorkerEntrypoint<Cloudflare.Env>
  implements ContainerUsageRpcMethods
{
  async recordStart(input: RecordStartInput): Promise<RecordStartResult> {
    const parsed = recordStartInputSchema.parse(input);
    const context = copyUsageContext(parsed);
    assertIdempotencyKey(
      parsed.idempotencyKey,
      startIdempotencyKey(parsed.service, parsed.instanceId, parsed.startEpochMs)
    );
    const mutation = {
      operation: 'start' as const,
      intervalId: intervalId(parsed.instanceId, parsed.startEpochMs),
      idempotencyKey: parsed.idempotencyKey,
      contextFingerprint: await usageContextFingerprint(context),
      payload: parsed,
      receivedAtMs: Date.now(),
    };
    const shard = this.env.FAILOVER_BUFFER.getByName(failoverBufferShardName(parsed.instanceId));
    const existing = await shard.getStartAdmission(mutation);
    if (existing.status === 'accepted') {
      return {
        success: true,
        ack: { intervalId: mutation.intervalId, durable: 'buffer', dedup: true },
      };
    }
    if (existing.status === 'rejected') {
      return { success: false, error: { code: existing.code, message: existing.message } };
    }
    if (existing.status === 'conflict') {
      throw new Error('Idempotency key was reused for a different usage mutation');
    }

    const admission = await validateStartSku(this.env, parsed.sku);
    const decision = await shard.admitStart(mutation, admission);
    if (decision.status === 'conflict') {
      throw new Error('Idempotency key was reused for a different usage mutation');
    }
    if (decision.status === 'rejected') {
      return {
        success: false,
        error: { code: decision.code, message: decision.message },
      };
    }
    return {
      success: true,
      ack: { intervalId: mutation.intervalId, durable: 'buffer', dedup: decision.dedup },
    };
  }

  async recordHeartbeat(input: RecordHeartbeatInput): Promise<HeartbeatAck> {
    const parsed = recordHeartbeatInputSchema.parse(input);
    if (parsed.context) assertContextMatches(parsed, parsed.context);
    assertIdempotencyKey(
      parsed.idempotencyKey,
      heartbeatIdempotencyKey(parsed.service, parsed.instanceId, parsed.startEpochMs, parsed.seq)
    );
    const ack = await this.buffer(
      {
        operation: 'heartbeat',
        intervalId: intervalId(parsed.instanceId, parsed.startEpochMs),
        idempotencyKey: parsed.idempotencyKey,
        contextFingerprint: parsed.context
          ? await usageContextFingerprint(parsed.context)
          : undefined,
        payload: parsed,
        receivedAtMs: Date.now(),
      },
      parsed.instanceId
    );
    return { ...ack, budget: { verdict: 'continue' } };
  }

  async recordStop(input: RecordStopInput): Promise<RecordAck> {
    const parsed = recordStopInputSchema.parse(input);
    assertContextMatches(parsed, parsed.context);
    assertIdempotencyKey(
      parsed.idempotencyKey,
      stopIdempotencyKey(parsed.service, parsed.instanceId, parsed.startEpochMs)
    );
    return await this.buffer(
      {
        operation: 'stop',
        intervalId: intervalId(parsed.instanceId, parsed.startEpochMs),
        idempotencyKey: parsed.idempotencyKey,
        contextFingerprint: await usageContextFingerprint(parsed.context),
        payload: parsed,
        receivedAtMs: Date.now(),
      },
      parsed.instanceId
    );
  }

  private async buffer(mutation: FailoverMutation, instanceId: string): Promise<RecordAck> {
    const shard = this.env.FAILOVER_BUFFER.getByName(failoverBufferShardName(instanceId));
    const result = await shard.enqueue(mutation);
    if (result.conflict) {
      throw new Error('Idempotency key was reused for a different usage mutation');
    }
    return { intervalId: mutation.intervalId, durable: 'buffer', dedup: result.dedup };
  }
}
