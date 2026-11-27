import { decodeAuditBatch } from '@kilocode/sts-contracts';
import type { AuditBatch } from '@kilocode/sts-contracts';
import { withDORetry } from '@kilocode/worker-utils';
import { getStreamDOStub } from './dos/StreamDO';
import type { StreamDO, StreamOutcome } from './dos/StreamDO';
import type { Env } from './env';
import { pageOperator } from './page';
import { deadLetterKey, putImmutable } from './relay/archive';
import { errorName } from './relay/error-name';
import { admittedOn } from './producers';

const DLQ_SUFFIX = '-dlq';
/**
 * A dead letter that can still recover (a batch behind a gap, or R2 down) is offered again this
 * often. With the DLQ consumers' `max_retries: 100` that is about 25 hours.
 */
const DEAD_LETTER_RETRY_SECONDS = 900;
/**
 * A dead letter behind a gap whose stream's head advanced within `DEAD_LETTER_PROGRESS_WINDOW_MS`
 * is behind a backlog that is draining, so it is offered again after this short delay instead.
 * Short retries stop after `DEAD_LETTER_LAST_SHORT_ATTEMPT`, keeping at least 40 long retries
 * (10 hours) of the window.
 */
const DEAD_LETTER_SHORT_RETRY_SECONDS = 30;
const DEAD_LETTER_PROGRESS_WINDOW_MS = 60_000;
const DEAD_LETTER_LAST_SHORT_ATTEMPT = 60;
/**
 * The DLQ delivery after which Queues drops the message (`max_retries: 100`, so 101 deliveries);
 * a batch still waiting then is paged as lost. It counts the deliveries the message reports.
 */
const DEAD_LETTER_FINAL_ATTEMPT = 101;
/** The StreamDO that rate-limits pages for bodies with no readable stream (not a valid stream name). */
const UNKNOWN_STREAM_OBJECT = '~unknown';
/**
 * Another producer's batch is filed and paged as `foreign/<receiving queue>`, never under the
 * stream it claims. A stream name cannot hold `/`, so no real stream shares this name.
 */
const FOREIGN_PREFIX = 'foreign/';
/**
 * An archive write that fails retries 60 s, 120 s, 240 s, 480 s, then every 15 minutes: with the
 * main consumer's `max_retries: 24` that spans about 5.25 hours before the DLQ takes over.
 */
const ARCHIVE_RETRY_BASE_SECONDS = 60;
const ARCHIVE_RETRY_CAP_SECONDS = 900;

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

  const refused: Message<unknown>[] = [];
  for (const message of batch.messages) {
    const auditBatch = await decodeMessage(message.body);
    if (auditBatch && admittedOn(batch.queue, auditBatch))
      await handleBatch(auditBatch, message, env);
    else refused.push(message);
  }
  // A body `encodeAuditBatch` did not produce never decodes, and another producer's batch never
  // belongs on this queue, so a retry cannot help: each is kept like a dead letter, not dropped.
  if (refused.length > 0) await keepDeadLetters(refused, batch.queue, env);
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
  | { kind: 'waiting'; reason: string; progressing: boolean }
  | { kind: 'lost'; reason: string };

/** 30 s while the stream's gap is closing (early deliveries only), else 15 minutes. */
export function deadLetterRetrySeconds(
  fate: Extract<DeadLetterFate, { kind: 'waiting' }>,
  attempts: number
): number {
  return fate.progressing && attempts <= DEAD_LETTER_LAST_SHORT_ATTEMPT
    ? DEAD_LETTER_SHORT_RETRY_SECONDS
    : DEAD_LETTER_RETRY_SECONDS;
}

/**
 * Handles messages that will never be delivered normally: a DLQ message, an undecodable body, or
 * a batch of another producer than the queue's (`producers.ts`).
 *
 * The messages are grouped by stream; streams run in parallel and each stream's batches run in
 * sequence order, so the batches an R2 outage or a gap dead-lettered archive themselves in one
 * pass once the cause is gone: an `accepted` or (archive-checked) `duplicate` batch is acked with
 * nothing kept. Once one batch of a stream is still waiting, the later ones are not offered
 * (they would only gap). Every other message has its raw bytes stored under
 * `dead-letter/<stream or unknown>/<enqueue time>-<id>.gz` (create-only, so a retry rewrites
 * nothing) and a waiting one is retried: after 30 s while its stream's head is advancing, else
 * after 15 minutes. A message that cannot recover (a forged or conflicting copy, another
 * producer's batch, an undecodable body, its final delivery, or bytes that could not be stored by
 * then) is acked and paged; each stream (and the unknown bucket) pages at most once an hour.
 */
async function keepDeadLetters(
  messages: readonly Message<unknown>[],
  queue: string,
  env: Env
): Promise<void> {
  type Letter = { message: Message<unknown>; auditBatch: AuditBatch | null; filedUnder: string };
  const groups = new Map<string, Letter[]>();
  for (const message of messages) {
    const auditBatch = await decodeMessage(message.body);
    // Another producer's batch is filed, grouped and paged under the receiving queue, never under
    // the stream it claims: a foreign writer can neither place objects under that stream's
    // dead-letter prefix nor use up its hourly page.
    let filedUnder = UNKNOWN_STREAM_OBJECT;
    if (auditBatch) {
      filedUnder = admittedOn(queue, auditBatch) ? auditBatch.stream : `${FOREIGN_PREFIX}${queue}`;
    }
    const group = groups.get(filedUnder) ?? [];
    group.push({ message, auditBatch, filedUnder });
    groups.set(filedUnder, group);
  }

  const lines = await Promise.all(
    [...groups.values()].map(async group => {
      group.sort(
        (left, right) => (left.auditBatch?.fromSeq ?? 0) - (right.auditBatch?.fromSeq ?? 0)
      );
      const groupLines: string[] = [];
      let blocked: DeadLetterFate | null = null;
      for (const { message, auditBatch, filedUnder } of group) {
        let fate: DeadLetterFate;
        if (!auditBatch) fate = { kind: 'lost', reason: 'undecodable' };
        else if (filedUnder !== auditBatch.stream) {
          fate = { kind: 'lost', reason: 'foreign_producer' };
        } else if (blocked) fate = blocked;
        else fate = await offerAgain(auditBatch, env);
        if (fate.kind === 'waiting') blocked = fate;
        const line = await settleDeadLetter(message, auditBatch, filedUnder, fate, queue, env);
        if (line) groupLines.push(line);
      }
      return groupLines;
    })
  );
  const paged = lines.flat();
  if (paged.length === 0) return;

  await pageOperator(
    env,
    `audit-relay gave up on message(s) from ${queue} (at most one page per stream an hour; the rest are in the logs). A stream behind a lost batch stalls until it is re-sent:\n${paged.join('\n')}`
  );
}

/** Acks, retries or gives up on one dead letter; returns its page line when it pages. */
async function settleDeadLetter(
  message: Message<unknown>,
  auditBatch: AuditBatch | null,
  filedUnder: string,
  fate: DeadLetterFate,
  queue: string,
  env: Env
): Promise<string | null> {
  const filedStream = filedUnder === UNKNOWN_STREAM_OBJECT ? null : filedUnder;
  const foreign = filedStream !== null && filedStream !== auditBatch?.stream;
  const log = { queue, stream: auditBatch?.stream ?? null, fromSeq: auditBatch?.fromSeq ?? null };
  if (fate.kind === 'recovered') {
    console.log(
      JSON.stringify({ event: 'audit_relay.dead_letter_recovered', ...log, outcome: fate.outcome })
    );
    message.ack();
    return null;
  }

  const final = message.attempts >= DEAD_LETTER_FINAL_ATTEMPT;
  const key = deadLetterKey(filedStream, message.timestamp, message.id);
  let reason = fate.reason;
  let where = `at ${key}`;
  try {
    await putImmutable(env.AUDIT_ARCHIVE, key, rawBytes(message.body), 'application/octet-stream');
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'audit_relay.dead_letter_write_failed',
        ...log,
        key,
        attempts: message.attempts,
        error: errorName(error),
      })
    );
    if (!final) {
      message.retry({ delaySeconds: DEAD_LETTER_RETRY_SECONDS });
      return null;
    }
    reason = `${fate.reason}, store_failed`;
    where = 'and its bytes could not be stored';
  }
  if (fate.kind === 'waiting' && !final) {
    const delaySeconds = deadLetterRetrySeconds(fate, message.attempts);
    console.log(
      JSON.stringify({
        event: 'audit_relay.dead_letter_waiting',
        ...log,
        key,
        reason,
        attempts: message.attempts,
        delaySeconds,
      })
    );
    message.retry({ delaySeconds });
    return null;
  }

  const stub = getStreamDOStub(env, filedUnder);
  const page = await stub.claimDeadLetterPage();
  console.error(
    JSON.stringify({
      event: 'audit_relay.dead_letter_given_up',
      ...log,
      key,
      toSeq: auditBatch?.toSeq ?? null,
      reason,
      attempts: message.attempts,
      paged: page,
    })
  );
  message.ack();
  if (!page) return null;
  const range = auditBatch && !foreign ? ` seq ${auditBatch.fromSeq}..${auditBatch.toSeq}` : '';
  return `${filedStream ?? 'unknown stream'}${range} (${reason}) after ${message.attempts} attempts ${where}`;
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
    case 'gap_stalled': {
      const advancedAt = outcome.headAdvancedAt;
      const progressing =
        advancedAt !== null && Date.now() - advancedAt <= DEAD_LETTER_PROGRESS_WINDOW_MS;
      return {
        kind: 'waiting',
        reason: outcome.kind === 'retry' ? outcome.reason : 'gap',
        progressing,
      };
    }
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
