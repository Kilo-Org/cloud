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
/**
 * A dead letter that can still recover (a batch behind a gap, or R2 down) is offered again this
 * often. With the DLQ consumers' `max_retries: 100` that is about 25 hours.
 */
const DEAD_LETTER_RETRY_SECONDS = 900;
/**
 * The DLQ delivery after which Queues drops the message (`max_retries: 100`, so 101 deliveries);
 * a batch still waiting then is paged as lost. It counts the deliveries the message reports.
 */
const DEAD_LETTER_FINAL_ATTEMPT = 101;
/** The StreamDO that rate-limits pages for bodies with no readable stream (not a valid stream name). */
const UNKNOWN_STREAM_OBJECT = '~unknown';
/** An archive write that fails retries 60 s, 120 s, … capped at 1 hour: 10 retries cover ~5 h. */
const ARCHIVE_RETRY_BASE_SECONDS = 60;
const ARCHIVE_RETRY_CAP_SECONDS = 3600;

export function archiveRetryDelaySeconds(attempts: number): number {
  return Math.min(
    ARCHIVE_RETRY_CAP_SECONDS,
    ARCHIVE_RETRY_BASE_SECONDS * 2 ** Math.min(Math.max(attempts, 1) - 1, 16)
  );
}

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

type DeadLetterFate =
  | { kind: 'recovered'; outcome: 'accepted' | 'duplicate' }
  | { kind: 'waiting'; reason: string }
  | { kind: 'lost'; reason: string };

/**
 * Handles messages that will never be delivered normally: a DLQ message or an undecodable body.
 *
 * A decodable batch is offered to its stream again first, lowest sequence first within the
 * consumer batch, so batches dead-lettered by an R2 outage or a gap archive themselves once the
 * cause is gone: an `accepted` or (archive-checked) `duplicate` batch is acked with nothing kept.
 * Every other message has its raw bytes stored under
 * `dead-letter/<stream or unknown>/<enqueue time>-<id>.gz` (create-only, so a retry rewrites
 * nothing). A batch still behind a gap or an R2 failure is then retried every 15 minutes; one
 * that cannot recover (a forged or conflicting copy, an undecodable body, or the final delivery)
 * is acked and paged. Each stream (and the unknown bucket) pages at most once an hour.
 */
async function keepDeadLetters(
  messages: readonly Message<unknown>[],
  queue: string,
  env: Env
): Promise<void> {
  const entries = await Promise.all(
    messages.map(async message => ({ message, auditBatch: await decodeMessage(message.body) }))
  );
  // Contiguous batches of one stream in one consumer batch archive in a single pass.
  entries.sort((left, right) => {
    const a = left.auditBatch;
    const b = right.auditBatch;
    if (!a || !b) return Number(!a) - Number(!b);
    if (a.stream !== b.stream) return a.stream < b.stream ? -1 : 1;
    return a.fromSeq - b.fromSeq;
  });

  const lines: string[] = [];
  for (const { message, auditBatch } of entries) {
    const fate: DeadLetterFate = auditBatch
      ? await offerAgain(auditBatch, env)
      : { kind: 'lost', reason: 'undecodable' };
    if (fate.kind === 'recovered') {
      console.log(
        JSON.stringify({
          event: 'audit_relay.dead_letter_recovered',
          queue,
          stream: auditBatch?.stream,
          toSeq: auditBatch?.toSeq,
          outcome: fate.outcome,
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
    if (fate.kind === 'waiting' && message.attempts < DEAD_LETTER_FINAL_ATTEMPT) {
      console.log(
        JSON.stringify({
          event: 'audit_relay.dead_letter_waiting',
          queue,
          key,
          stream: auditBatch?.stream,
          fromSeq: auditBatch?.fromSeq,
          reason: fate.reason,
          attempts: message.attempts,
        })
      );
      message.retry({ delaySeconds: DEAD_LETTER_RETRY_SECONDS });
      continue;
    }

    const stub = getStreamDOStub(env, auditBatch?.stream ?? UNKNOWN_STREAM_OBJECT);
    const page = await stub.claimDeadLetterPage();
    console.error(
      JSON.stringify({
        event: 'audit_relay.dead_letter_stored',
        queue,
        key,
        stream: auditBatch?.stream ?? null,
        fromSeq: auditBatch?.fromSeq ?? null,
        toSeq: auditBatch?.toSeq ?? null,
        reason: fate.reason,
        attempts: message.attempts,
        paged: page,
      })
    );
    message.ack();
    if (page) {
      const range = auditBatch ? ` seq ${auditBatch.fromSeq}..${auditBatch.toSeq}` : '';
      lines.push(
        `${auditBatch?.stream ?? 'unknown stream'}${range} (${fate.reason}) after ${message.attempts} attempts at ${key}`
      );
    }
  }
  if (lines.length === 0) return;

  await pageOperator(
    env,
    `audit-relay gave up on message(s) from ${queue}; their bytes are in R2 (at most one page per stream an hour; the rest are in the logs). A stream behind a lost batch stalls until it is re-sent:\n${lines.join('\n')}`
  );
}

/** Offers a dead-lettered batch to its stream again; the archive decides what it is now. */
async function offerAgain(auditBatch: AuditBatch, env: Env): Promise<DeadLetterFate> {
  const outcome = await withDORetry<DurableObjectStub<StreamDO>, StreamOutcome>(
    () => getStreamDOStub(env, auditBatch.stream),
    stub => stub.acceptBatch(auditBatch),
    'acceptBatch'
  );
  switch (outcome.kind) {
    case 'accepted':
    case 'duplicate':
      return { kind: 'recovered', outcome: outcome.kind };
    case 'retry':
      return { kind: 'waiting', reason: outcome.reason };
    case 'gap_stalled':
      return { kind: 'waiting', reason: 'gap' };
    case 'dropped':
      return { kind: 'lost', reason: outcome.reason };
    case 'duplicate_mismatch':
      return { kind: 'lost', reason: `duplicate_${outcome.reason}` };
  }
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
    case 'retry': {
      // An R2 failure can outlast ten one-minute retries; doubling keeps the batch in the main
      // queue for about five hours before the DLQ offers it again for about a day.
      const delaySeconds =
        outcome.reason === 'archive'
          ? archiveRetryDelaySeconds(message.attempts)
          : outcome.delaySeconds;
      console.log(
        JSON.stringify({
          event: 'audit_relay.batch_retry',
          stream: outcome.stream,
          fromSeq: outcome.fromSeq,
          reason: outcome.reason,
          delaySeconds,
        })
      );
      message.retry({ delaySeconds });
      return;
    }
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
