import { decodeAuditBatch } from '@kilocode/sts-contracts';
import type { AuditBatch } from '@kilocode/sts-contracts';
import { withDORetry } from '@kilocode/worker-utils';
import { getStreamDOStub } from './dos/StreamDO';
import type { StreamDO, StreamOutcome } from './dos/StreamDO';
import type { Env } from './env';
import { errorName } from './relay/error-name';
import { pageSlack } from './relay/slack';
import { createSecretSource } from './secrets';

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
    case 'dropped':
      console.error(
        JSON.stringify({
          event: 'audit_relay.batch_dropped',
          stream: outcome.stream,
          fromSeq: outcome.fromSeq,
          reason: outcome.reason,
        })
      );
      await pageDrop(env, outcome);
      message.ack();
      return;
  }
}

async function pageDrop(
  env: Env,
  outcome: Extract<StreamOutcome, { kind: 'dropped' }>
): Promise<void> {
  try {
    const webhook = await createSecretSource(env).get('AUDIT_RELAY_SLACK_WEBHOOK_PAGE');
    const delivered = await pageSlack(
      webhook,
      `audit stream ${outcome.stream} dropped a batch at seq ${outcome.fromSeq}: ${outcome.reason}`,
      fetch
    );
    if (!delivered) {
      console.error(
        JSON.stringify({ event: 'audit_relay.page_undelivered', reason: outcome.reason })
      );
    }
  } catch (error) {
    console.error(JSON.stringify({ event: 'audit_relay.page_failed', error: errorName(error) }));
  }
}

function toBytes(body: unknown): Uint8Array | null {
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body))
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  return null;
}
