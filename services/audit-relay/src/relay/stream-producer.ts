import type { AuditBatch } from '@kilocode/sts-contracts';

/**
 * A queue message carries no producer identity, so the queue names it: each producer has its own
 * audit queue per environment, and only that producer may send to it (the repository guard in
 * services/sts/test/repo enforces the grants). A batch must belong to its queue's producer and
 * environment before any stream sees it:
 *
 * * `kilo-audit-uts[-staging|-local]`: only `uts:<environment>:<0-7>`, one of the 8 UTS audit
 *   shards, with every event `source` equal to `kilo:uts:<environment>`;
 * * `kilo-audit[-staging|-local]`: only `sts:<environment>:<rest>` with `kilo:sts:<environment>`;
 * * `kilo-audit-migration-proxy[-staging|-local]` (design Q66): only
 *   `migration-proxy:<environment>:<rest>` with `kilo:migration-proxy:<environment>`.
 *
 * A dead-letter queue (`<queue>-dlq`) names the same producer as its queue.
 */

type Producer = {
  kind: 'uts' | 'sts' | 'migration-proxy';
  environment: 'production' | 'staging' | 'development';
};

const DLQ_SUFFIX = '-dlq';

const QUEUE_PRODUCERS: ReadonlyMap<string, Producer> = new Map([
  ['kilo-audit', { kind: 'sts', environment: 'production' }],
  ['kilo-audit-staging', { kind: 'sts', environment: 'staging' }],
  ['kilo-audit-local', { kind: 'sts', environment: 'development' }],
  ['kilo-audit-uts', { kind: 'uts', environment: 'production' }],
  ['kilo-audit-uts-staging', { kind: 'uts', environment: 'staging' }],
  ['kilo-audit-uts-local', { kind: 'uts', environment: 'development' }],
  ['kilo-audit-migration-proxy', { kind: 'migration-proxy', environment: 'production' }],
  ['kilo-audit-migration-proxy-staging', { kind: 'migration-proxy', environment: 'staging' }],
  ['kilo-audit-migration-proxy-local', { kind: 'migration-proxy', environment: 'development' }],
]);

const UTS_SHARD = /^[0-7]$/;

/**
 * `queue_not_allowed`: no producer owns the queue. `stream_not_allowed`: the stream is not one the
 * queue's producer writes in its environment. `source_mismatch`: an event's `source` names another
 * producer or environment.
 */
export type StreamRefusal = 'queue_not_allowed' | 'stream_not_allowed' | 'source_mismatch';

export function streamRefusal(batch: AuditBatch, queue: string): StreamRefusal | null {
  const producer = QUEUE_PRODUCERS.get(
    queue.endsWith(DLQ_SUFFIX) ? queue.slice(0, -DLQ_SUFFIX.length) : queue
  );
  if (producer === undefined) return 'queue_not_allowed';
  const prefix = `${producer.kind}:${producer.environment}:`;
  if (!batch.stream.startsWith(prefix)) return 'stream_not_allowed';
  const rest = batch.stream.slice(prefix.length);
  if (producer.kind === 'uts' ? !UTS_SHARD.test(rest) : rest.length === 0) {
    return 'stream_not_allowed';
  }
  const source = `kilo:${producer.kind}:${producer.environment}`;
  return batch.events.every(event => event.source === source) ? null : 'source_mismatch';
}
