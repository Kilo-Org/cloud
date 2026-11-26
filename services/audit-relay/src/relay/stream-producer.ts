import type { AuditBatch } from '@kilocode/sts-contracts';

/**
 * A queue message carries no producer identity, so the relay checks that a batch's stream name and
 * its events' `source` name the same producer and environment before any stream sees it:
 *
 * * `uts:<environment>:<0-7>`, one of the 8 UTS audit shards, with `kilo:uts:<environment>`;
 * * `sts:<environment>:<rest>` with `kilo:sts:<environment>`.
 *
 * This catches a producer bug that would write another producer's stream. It cannot stop a
 * compromised producer, which can name any stream and source it likes.
 */
const UTS_STREAM = /^uts:(production|staging|development):[0-7]$/;
const STS_STREAM = /^sts:(production|staging|development):.+$/;

/** `stream_not_allowed`: no known producer owns the name. `source_mismatch`: an event's `source` names another producer or environment. */
export type StreamRefusal = 'stream_not_allowed' | 'source_mismatch';

export function streamRefusal(batch: AuditBatch): StreamRefusal | null {
  const owner = UTS_STREAM.exec(batch.stream) ?? STS_STREAM.exec(batch.stream);
  if (owner === null) return 'stream_not_allowed';
  const producer = batch.stream.slice(0, 3);
  const source = `kilo:${producer}:${owner[1]}`;
  return batch.events.every(event => event.source === source) ? null : 'source_mismatch';
}
