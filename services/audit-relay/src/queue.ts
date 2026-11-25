import { decodeAuditBatch } from '@kilocode/sts-contracts';
import type { AuditBatch } from '@kilocode/sts-contracts';
import { withDORetry } from '@kilocode/worker-utils';
import { getStreamDOStub } from './dos/StreamDO';
import type { StreamDO, StreamOutcome } from './dos/StreamDO';
import type { Env } from './env';
import { pageOperator } from './page';
import { errorName } from './relay/error-name';

const DLQ_SUFFIX = '-dlq';

export async function handleQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  if (batch.queue.endsWith(DLQ_SUFFIX)) {
    for (const message of batch.messages) {
      console.error(
        JSON.stringify({
          event: 'audit_relay.dead_letter',
          queue: batch.queue,
          attempts: message.attempts,
        })
      );
      message.ack();
    }
    return;
  }

  for (const message of batch.messages) await handleMessage(message, env);
}

async function handleMessage(message: Message<unknown>, env: Env): Promise<void> {
  const bytes = toBytes(message.body);
  if (!bytes) {
    console.error(
      JSON.stringify({ event: 'audit_relay.message_not_bytes', attempts: message.attempts })
    );
    message.ack();
    return;
  }

  let auditBatch: AuditBatch;
  try {
    auditBatch = await decodeAuditBatch(bytes);
  } catch (error) {
    // A body the producer could not have produced from `encodeAuditBatch` will never decode; a
    // retry cannot fix it, so it is acked and logged without the payload.
    console.error(
      JSON.stringify({ event: 'audit_relay.message_undecodable', error: errorName(error) })
    );
    message.ack();
    return;
  }

  const outcome = await withDORetry<DurableObjectStub<StreamDO>, StreamOutcome>(
    () => getStreamDOStub(env, auditBatch.stream),
    stub => stub.acceptBatch(auditBatch),
    'acceptBatch'
  );
  await applyOutcome(outcome, env, message);
}

async function applyOutcome(
  outcome: StreamOutcome,
  env: Env,
  message: Message<unknown>
): Promise<void> {
  switch (outcome.kind) {
    case 'accepted':
      console.log(
        JSON.stringify({
          event: 'audit_relay.batch_archived',
          stream: outcome.stream,
          fromSeq: outcome.fromSeq,
          toSeq: outcome.toSeq,
          archive: outcome.archive,
        })
      );
      message.ack();
      return;
    case 'duplicate':
      console.log(
        JSON.stringify({
          event: 'audit_relay.batch_duplicate',
          stream: outcome.stream,
          toSeq: outcome.toSeq,
          headSeq: outcome.headSeq,
          replayed: outcome.replayed,
        })
      );
      message.ack();
      return;
    case 'retry':
      console.log(
        JSON.stringify({
          event: 'audit_relay.batch_retry',
          stream: outcome.stream,
          fromSeq: outcome.fromSeq,
          reason: outcome.reason,
          delaySeconds: outcome.delaySeconds,
        })
      );
      message.retry({ delaySeconds: outcome.delaySeconds });
      return;
    case 'gap_stalled':
      console.error(
        JSON.stringify({
          event: 'audit_relay.gap_stalled',
          stream: outcome.stream,
          expectedSeq: outcome.expectedSeq,
          attempts: outcome.attempts,
          stalledMs: outcome.stalledMs,
        })
      );
      await pageOperator(
        env,
        `audit stream ${outcome.stream} has waited ${Math.round(outcome.stalledMs / 1000)} s for seq ${outcome.expectedSeq} and turned away ${outcome.attempts} later batches`
      );
      message.retry({ delaySeconds: outcome.delaySeconds });
      return;
    case 'hot_gap':
      console.error(
        JSON.stringify({
          event: 'audit_relay.hot_store_gap',
          stream: outcome.stream,
          fromSeq: outcome.fromSeq,
          toSeq: outcome.toSeq,
          reason: outcome.reason,
        })
      );
      await pageOperator(
        env,
        `audit stream ${outcome.stream} archived seq ${outcome.fromSeq}..${outcome.toSeq} without the hot copy: ${outcome.reason}`
      );
      message.ack();
      return;
    case 'dropped':
      console.error(
        JSON.stringify({
          event: 'audit_relay.batch_dropped',
          stream: outcome.stream,
          fromSeq: outcome.fromSeq,
          reason: outcome.reason,
        })
      );
      await pageOperator(
        env,
        `audit stream ${outcome.stream} could not archive a batch at seq ${outcome.fromSeq}: ${outcome.reason}`
      );
      message.ack();
      return;
    case 'duplicate_mismatch':
      console.error(
        JSON.stringify({
          event: 'audit_relay.duplicate_mismatch',
          stream: outcome.stream,
          fromSeq: outcome.fromSeq,
          toSeq: outcome.toSeq,
          reason: outcome.reason,
        })
      );
      await pageOperator(
        env,
        `audit stream ${outcome.stream} received seq ${outcome.fromSeq}..${outcome.toSeq} again and it disagrees with the archive: ${outcome.reason}`
      );
      message.ack();
      return;
  }
}

function toBytes(body: unknown): Uint8Array | null {
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  return null;
}
