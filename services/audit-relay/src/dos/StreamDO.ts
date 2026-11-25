import { DurableObject } from 'cloudflare:workers';
import type { AuditBatch } from '@kilocode/sts-contracts';
import { withDORetry } from '@kilocode/worker-utils';
import type { Env } from '../env';
import { ArchiveConflictError, writeArchivedBatch } from '../relay/archive';
import { ingestAuditEvents } from '../relay/axiom';
import { GENESIS_HASH, chainHash } from '../relay/chain';
import { errorName } from '../relay/error-name';
import { SecretSourceError, createSecretSource } from '../secrets';
import { getRegistryDOStub } from './RegistryDO';

export type StreamHead = { seq: number; hash: string };

const GAP_RETRY_SECONDS = 30;
const FAILURE_RETRY_SECONDS = 60;

export type StreamRetryReason = 'gap' | 'axiom' | 'secrets' | 'archive';
export type StreamDropReason = 'axiom_rejected' | 'secrets_denied' | 'archive_conflict';

/**
 * One batch's fate. `accepted` and `duplicate` are final; `retry` asks the queue for another
 * attempt; `dropped` is a non-retryable failure the caller must page and ack.
 */
export type StreamOutcome =
  | {
      kind: 'accepted';
      stream: string;
      fromSeq: number;
      toSeq: number;
      hash: string;
      archive: 'written' | 'existing';
    }
  | { kind: 'duplicate'; stream: string; toSeq: number; headSeq: number }
  | {
      kind: 'retry';
      stream: string;
      fromSeq: number;
      reason: StreamRetryReason;
      delaySeconds: number;
    }
  | { kind: 'dropped'; stream: string; fromSeq: number; reason: StreamDropReason };

/**
 * The single writer for one audit stream: it owns the chain head, the archive object for the
 * batch, and the Axiom ingest, in that order. Queues deliver at least once and in no fixed order,
 * so every step after the head read is idempotent by chain hash.
 */
export class StreamDO extends DurableObject<Env> {
  // Serialises the batches addressed to this stream inside the instance; the head in storage is
  // what a fresh instance reads, so eviction only ever replays an idempotent attempt.
  private tail: Promise<unknown> = Promise.resolve();

  acceptBatch(batch: AuditBatch): Promise<StreamOutcome> {
    const run = this.tail.then(
      () => this.applyBatch(batch),
      () => this.applyBatch(batch)
    );
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async applyBatch(batch: AuditBatch): Promise<StreamOutcome> {
    const head = await this.readHead();
    if (batch.toSeq <= head.seq) {
      return { kind: 'duplicate', stream: batch.stream, toSeq: batch.toSeq, headSeq: head.seq };
    }
    if (batch.fromSeq > head.seq + 1) {
      return {
        kind: 'retry',
        stream: batch.stream,
        fromSeq: batch.fromSeq,
        reason: 'gap',
        delaySeconds: GAP_RETRY_SECONDS,
      };
    }

    const fromSeq = Math.max(batch.fromSeq, head.seq + 1);
    const trimmed: AuditBatch =
      fromSeq === batch.fromSeq
        ? batch
        : { ...batch, fromSeq, events: batch.events.slice(fromSeq - batch.fromSeq) };
    const hash = await chainHash(head.hash, trimmed);

    let archive: 'written' | 'existing';
    try {
      archive = await writeArchivedBatch(this.env.AUDIT_ARCHIVE, {
        batch: trimmed,
        prevHash: head.hash,
        hash,
      });
    } catch (error) {
      if (error instanceof ArchiveConflictError) {
        return { kind: 'dropped', stream: trimmed.stream, fromSeq, reason: 'archive_conflict' };
      }
      console.error(
        JSON.stringify({
          event: 'audit_relay.archive_failed',
          stream: trimmed.stream,
          fromSeq,
          error: errorName(error),
        })
      );
      return {
        kind: 'retry',
        stream: trimmed.stream,
        fromSeq,
        reason: 'archive',
        delaySeconds: FAILURE_RETRY_SECONDS,
      };
    }

    let token: string;
    try {
      token = await createSecretSource(this.env).get('AUDIT_RELAY_AXIOM_TOKEN');
    } catch (error) {
      if (error instanceof SecretSourceError && !error.retryable) {
        return { kind: 'dropped', stream: trimmed.stream, fromSeq, reason: 'secrets_denied' };
      }
      return {
        kind: 'retry',
        stream: trimmed.stream,
        fromSeq,
        reason: 'secrets',
        delaySeconds: FAILURE_RETRY_SECONDS,
      };
    }

    const ingest = await ingestAuditEvents(
      { url: this.env.AXIOM_URL, dataset: this.env.AXIOM_DATASET, token },
      trimmed.events,
      fetch
    );
    if (ingest.kind === 'retryable') {
      return {
        kind: 'retry',
        stream: trimmed.stream,
        fromSeq,
        reason: 'axiom',
        delaySeconds: FAILURE_RETRY_SECONDS,
      };
    }
    if (ingest.kind === 'rejected') {
      return { kind: 'dropped', stream: trimmed.stream, fromSeq, reason: 'axiom_rejected' };
    }

    await this.recordHead(trimmed.stream, trimmed.toSeq, hash);
    await this.ctx.storage.put('stream', trimmed.stream);
    await this.ctx.storage.put('head', { seq: trimmed.toSeq, hash });
    return {
      kind: 'accepted',
      stream: trimmed.stream,
      fromSeq,
      toSeq: trimmed.toSeq,
      hash,
      archive,
    };
  }

  private async readHead(): Promise<StreamHead> {
    const stored = await this.ctx.storage.get<StreamHead>('head');
    return stored ?? { seq: 0, hash: GENESIS_HASH };
  }

  // The registry only indexes heads for the checkpoint and verify jobs. A failure there must not
  // stall the stream, so the head still advances and the gap is logged for an operator.
  private async recordHead(stream: string, seq: number, hash: string): Promise<void> {
    try {
      await withDORetry(
        () => getRegistryDOStub(this.env),
        stub => stub.recordHead(stream, seq, hash),
        'recordHead'
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'audit_relay.registry_record_failed',
          stream,
          seq,
          error: errorName(error),
        })
      );
    }
  }
}

export function getStreamDOStub(
  env: Pick<Env, 'AUDIT_STREAM'>,
  stream: string
): DurableObjectStub<StreamDO> {
  return env.AUDIT_STREAM.get(env.AUDIT_STREAM.idFromName(stream));
}
