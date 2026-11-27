import type { AuditBatch } from '@kilocode/sts-contracts';

/** The one producer a queue carries: its streams' name prefix and its events' `source`. */
type QueueProducer = { streamPrefix: string; source: string };

function producer(name: string, environment: 'production' | 'staging' | 'development') {
  return { streamPrefix: `${name}:${environment}:`, source: `kilo:${name}:${environment}` };
}

/**
 * Each audit queue (and its `-dlq`) carries one producer in one environment (design Q66): STS on
 * `kilo-audit[-staging|-local]`, the migration proxy on `kilo-audit-migration-proxy[-...]`. A
 * batch whose stream or event source belongs to another producer, or that arrives on a queue this
 * table does not name, is dead-lettered and paged, never archived: a producer's queue access then
 * cannot write into another producer's streams.
 */
const QUEUE_PRODUCERS: Readonly<Record<string, QueueProducer>> = {
  'kilo-audit': producer('sts', 'production'),
  'kilo-audit-staging': producer('sts', 'staging'),
  'kilo-audit-local': producer('sts', 'development'),
  'kilo-audit-migration-proxy': producer('migration-proxy', 'production'),
  'kilo-audit-migration-proxy-staging': producer('migration-proxy', 'staging'),
  'kilo-audit-migration-proxy-local': producer('migration-proxy', 'development'),
};

const DLQ_SUFFIX = '-dlq';

/** True when `batch` belongs to the producer of `queue` (a dead-letter queue names its source queue). */
export function admittedOn(queue: string, batch: AuditBatch): boolean {
  const source = queue.endsWith(DLQ_SUFFIX) ? queue.slice(0, -DLQ_SUFFIX.length) : queue;
  const expected = QUEUE_PRODUCERS[source];
  if (expected === undefined) return false;
  return (
    batch.stream.startsWith(expected.streamPrefix) &&
    batch.events.every(event => event.source === expected.source)
  );
}
