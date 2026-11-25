import { decodeAuditBatch } from '@kilocode/sts-contracts';
import type { AuditBatch } from '@kilocode/sts-contracts';
import { withDORetry } from '@kilocode/worker-utils';
import { getStreamDOStub } from './dos/StreamDO';
import type { StreamDO, StreamOutcome } from './dos/StreamDO';
import type { Env } from './env';
import { pageOperator } from './page';
import { deadLetterKey, putImmutable } from './relay/archive';
import { errorName } from './relay/error-name';

const DLQ_SUFFIX = '-dlq';
/** A dead letter whose R2 write fails stays in the DLQ; its consumer retries it this often. */
const DEAD_LETTER_RETRY_SECONDS = 300;
/** The StreamDO that rate-limits pages for bodies with no readable stream (not a valid stream name). */
const UNKNOWN_STREAM_OBJECT = '~unknown';

export async function handleQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  if (batch.queue.endsWith(DLQ_SUFFIX)) {
    await keepDeadLetters(batch.messages, batch.queue, env);
    return;
  }

  const unreadable: Message<unknown>[] = [];
  for (const message of batch.messages) {
    const auditBatch = await decodeMessage(message.body);
    if (auditBatch) await handleBatch(auditBatch, message, env);
    else unreadable.push(message);
  }
  // A body `encodeAuditBatch` did not produce never decodes, so a retry cannot help: it is kept
  // like a dead letter rather than dropped.
  if (unreadable.length > 0) await keepDeadLetters(unreadable, batch.queue, env);
}

async function handleBatch(
  auditBatch: AuditBatch,
  message: Message<unknown>,
  env: Env
): Promise<void> {
  const outcome = await withDORetry<DurableObjectStub<StreamDO>, StreamOutcome>(
    () => getStreamDOStub(env, auditBatch.stream),
    stub => stub.acceptBatch(auditBatch),
    'acceptBatch'
  );
  await applyOutcome(outcome, env, message);
}

/**
 * Handles messages that will never be delivered normally: a DLQ message or an undecodable body.
 *
 * A batch at or below its stream's head is already archived (its hot copy, if owed, belongs to
 * the StreamDO alarm), so it is acked as a no-op. Every other message has its raw bytes stored
 * under `dead-letter/<stream or unknown>/<enqueue time>-<id>.gz` (a lock rule keeps that prefix
 * as long as the archive) and is acked; a failed write retries it. Each stream (and the unknown
 * bucket) pages at most once an hour, with stream, range and key only.
 */
async function keepDeadLetters(
  messages: readonly Message<unknown>[],
  queue: string,
  env: Env
): Promise<void> {
  const lines: string[] = [];
  for (const message of messages) {
    const auditBatch = await decodeMessage(message.body);
    const stub = getStreamDOStub(env, auditBatch?.stream ?? UNKNOWN_STREAM_OBJECT);
    if (auditBatch && auditBatch.toSeq <= (await stub.headSeq())) {
      console.log(
        JSON.stringify({
          event: 'audit_relay.dead_letter_already_archived',
          queue,
          stream: auditBatch.stream,
          toSeq: auditBatch.toSeq,
        })
      );
      message.ack();
      continue;
    }

    const key = deadLetterKey(auditBatch?.stream ?? null, message.timestamp, message.id);
    try {
      await putImmutable(
        env.AUDIT_ARCHIVE,
        key,
        rawBytes(message.body),
        'application/octet-stream'
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'audit_relay.dead_letter_write_failed',
          queue,
          key,
          error: errorName(error),
        })
      );
      message.retry({ delaySeconds: DEAD_LETTER_RETRY_SECONDS });
      continue;
    }
    const page = await stub.claimDeadLetterPage();
    console.error(
      JSON.stringify({
        event: 'audit_relay.dead_letter_stored',
        queue,
        key,
        stream: auditBatch?.stream ?? null,
        fromSeq: auditBatch?.fromSeq ?? null,
        toSeq: auditBatch?.toSeq ?? null,
        attempts: message.attempts,
        paged: page,
      })
    );
    message.ack();
    if (page) {
      const range = auditBatch ? ` seq ${auditBatch.fromSeq}..${auditBatch.toSeq}` : '';
      lines.push(
        `${auditBatch?.stream ?? 'unknown stream'}${range} after ${message.attempts} attempts at ${key}`
      );
    }
  }
  if (lines.length === 0) return;

  await pageOperator(
    env,
    `audit-relay kept undelivered message(s) from ${queue} in R2 (at most one page per stream an hour; the rest are in the logs); each named stream stalls until its batch is re-sent:\n${lines.join('\n')}`
  );
}

async function decodeMessage(body: unknown): Promise<AuditBatch | null> {
  const bytes = toBytes(body);
  if (!bytes) return null;
  try {
    return await decodeAuditBatch(bytes);
  } catch {
    return null;
  }
}

/** The body as stored bytes: producers send bytes; a string is kept as text, anything else as JSON. */
function rawBytes(body: unknown): Uint8Array {
  const bytes = toBytes(body);
  if (bytes) return bytes;
  if (typeof body === 'string') return new TextEncoder().encode(body);
  try {
    return new TextEncoder().encode(JSON.stringify(body) ?? String(body));
  } catch {
    return new TextEncoder().encode(String(body));
  }
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
          hotCopy: outcome.hotCopy,
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
