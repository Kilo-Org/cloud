import {
  archiveObjectKey,
  archiveSequenceOf,
  archiveStreamPrefix,
  readArchivedObject,
  type ArchiveBucket,
} from './relay/archive';
import { chainHash } from './relay/chain';

/** A chain position whose hash the walk has recomputed (or a signed checkpoint vouches for). */
export type ChainPosition = { seq: number; hash: string };

export type VerifyFailureReason =
  | 'checkpoint_read'
  | 'checkpoint_signature'
  | 'archive_read'
  | 'chain'
  | 'checkpoint_mismatch'
  | 'checkpoint_stale'
  | 'head';

export type StreamWalk =
  | { kind: 'done'; position: ChainPosition; objects: number; bytes: number }
  | { kind: 'paused'; position: ChainPosition; objects: number; bytes: number }
  | { kind: 'failed'; reason: VerifyFailureReason; detail: string };

const LIST_PAGE = 1000;

/**
 * Recomputes one stream's chain from `from` to `head`, reading at most `budget.objects` objects
 * and stopping after the object that takes the decompressed total past `budget.bytes`.
 *
 * The listing starts after the object at `from.seq`, so a walk never re-reads what an earlier
 * pass verified. When `checkpoint` is given, the chain must land on its sequence at an object
 * boundary with its hash: that is what ties the archive to the signed (and outside) copy. The
 * walk stops at the registry head read for this slice; objects archived after it belong to the
 * next pass.
 */
export async function walkStream(
  bucket: ArchiveBucket,
  input: {
    stream: string;
    from: ChainPosition;
    checkpoint: ChainPosition | null;
    head: ChainPosition;
    budget: { objects: number; bytes: number };
  }
): Promise<StreamWalk> {
  const { stream, checkpoint, head, budget } = input;
  let position = input.from;
  let objects = 0;
  let bytes = 0;
  const prefix = archiveStreamPrefix(stream);
  const fail = (reason: VerifyFailureReason, detail: string): StreamWalk => ({
    kind: 'failed',
    reason,
    detail: `stream ${stream}: ${detail}`,
  });

  if (position.seq > head.seq) {
    return fail('head', `verified seq ${position.seq} is above the registry head ${head.seq}`);
  }
  if (checkpoint && checkpoint.seq > head.seq) {
    return fail('head', `checkpoint seq ${checkpoint.seq} is above the registry head ${head.seq}`);
  }
  if (checkpoint && checkpoint.seq === position.seq && checkpoint.hash !== position.hash) {
    return fail('checkpoint_mismatch', `checkpoint hash at ${checkpoint.seq} differs`);
  }

  while (position.seq < head.seq) {
    if (objects >= budget.objects || bytes >= budget.bytes) {
      return { kind: 'paused', position, objects, bytes };
    }
    const page = await bucket.list({
      prefix,
      startAfter: position.seq > 0 ? archiveObjectKey(stream, position.seq) : undefined,
      limit: Math.min(LIST_PAGE, budget.objects - objects),
    });
    if (page.objects.length === 0) {
      return fail('head', `archive ends at ${position.seq}, registry head is ${head.seq}`);
    }

    for (const listed of page.objects) {
      const key = listed.key;
      const seq = archiveSequenceOf(key);
      if (seq === null) return fail('archive_read', `unexpected object key ${key}`);

      const read = await readArchivedObject(bucket, key);
      if (read.kind !== 'ok') return fail('archive_read', `${read.kind} object ${key}`);
      const { batch, prevHash, hash } = read.object;
      if (batch.stream !== stream) return fail('chain', `${key} names stream ${batch.stream}`);
      if (batch.toSeq !== seq) return fail('chain', `${key} names sequence ${batch.toSeq}`);
      if (batch.fromSeq !== position.seq + 1) {
        return fail('chain', `${key} starts at ${batch.fromSeq}, expected ${position.seq + 1}`);
      }
      if (prevHash !== position.hash) {
        return fail('chain', `${key} links ${prevHash}, expected ${position.hash}`);
      }
      if ((await chainHash(prevHash, batch)) !== hash) {
        return fail('chain', `${key} stores a hash that does not match its batch`);
      }

      const previousSeq = position.seq;
      position = { seq, hash };
      objects += 1;
      bytes += read.bytes;

      if (checkpoint && previousSeq < checkpoint.seq && seq >= checkpoint.seq) {
        if (seq !== checkpoint.seq) {
          return fail('checkpoint_mismatch', `checkpoint seq ${checkpoint.seq} is inside ${key}`);
        }
        if (hash !== checkpoint.hash) {
          return fail('checkpoint_mismatch', `checkpoint hash at ${checkpoint.seq} differs`);
        }
      }
      if (seq > head.seq) {
        return fail('head', `${key} passes the registry head ${head.seq}`);
      }
      if (seq === head.seq) break;
      if (bytes >= budget.bytes) break;
    }
  }

  if (position.hash !== head.hash) {
    return fail('head', `archive hash at ${position.seq} is not the registry head`);
  }
  return { kind: 'done', position, objects, bytes };
}
