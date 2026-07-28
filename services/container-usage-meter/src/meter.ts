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
    const result = await applyStart(
      this.env,
      parsed,
      id,
      await usageContextFingerprint(context),
      Date.now()
    );
    switch (result.kind) {
      case 'rejected':
        return { success: false, error: { code: result.code, message: result.message } };
      case 'applied':
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
    const result = await applyHeartbeat(
      this.env,
      parsed,
      id,
      await usageContextFingerprint(parsed.context),
      Date.now()
    );
    return {
      intervalId: id,
      durable: 'pg',
      dedup: result.dedup,
      budget: { verdict: 'continue' },
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
    const result = await applyStop(
      this.env,
      parsed,
      id,
      await usageContextFingerprint(parsed.context),
      Date.now()
    );
    return { intervalId: id, durable: 'pg', dedup: result.dedup };
  }
}
