import { describe, expect, it } from 'vitest';
import { archiveObjectKey, writeArchivedBatch } from '../src/relay/archive';
import { GENESIS_HASH, chainHash } from '../src/relay/chain';
import { walkStream, type ChainPosition } from '../src/verify';
import { auditBatch, env, uniqueStream } from './helpers';

/** Archives contiguous batches ending at each `toSeqs` entry; returns the position after each. */
async function archiveChain(stream: string, toSeqs: number[]): Promise<ChainPosition[]> {
  const positions: ChainPosition[] = [];
  let previous: ChainPosition = { seq: 0, hash: GENESIS_HASH };
  for (const toSeq of toSeqs) {
    const batch = auditBatch(previous.seq + 1, toSeq, stream);
    const hash = await chainHash(previous.hash, batch);
    await writeArchivedBatch(env.AUDIT_ARCHIVE, { batch, prevHash: previous.hash, hash });
    previous = { seq: toSeq, hash };
    positions.push(previous);
  }
  return positions;
}

/** The archive bucket, recording every list option and every object read. */
function countingBucket() {
  const lists: R2ListOptions[] = [];
  const reads: string[] = [];
  const bucket = {
    put: env.AUDIT_ARCHIVE.put.bind(env.AUDIT_ARCHIVE),
    head: (key: string) => env.AUDIT_ARCHIVE.head(key),
    get: (key: string) => {
      reads.push(key);
      return env.AUDIT_ARCHIVE.get(key);
    },
    list: (options?: R2ListOptions) => {
      lists.push(options ?? {});
      return env.AUDIT_ARCHIVE.list(options);
    },
  };
  return { bucket, lists, reads };
}

describe('walkStream', () => {
  it('pauses at the budget and resumes after the last verified object', async () => {
    const stream = uniqueStream('walk-budget');
    const [, second, third] = await archiveChain(stream, [2, 5, 6]);
    const { bucket, lists, reads } = countingBucket();
    const genesis = { seq: 0, hash: GENESIS_HASH };

    const paused = await walkStream(bucket, {
      stream,
      from: genesis,
      checkpoint: null,
      head: third,
      budget: 2,
    });
    expect(paused).toEqual({ kind: 'paused', position: second, objects: 2 });

    const done = await walkStream(bucket, {
      stream,
      from: second,
      checkpoint: null,
      head: third,
      budget: 2,
    });
    expect(done).toEqual({ kind: 'done', position: third, objects: 1 });
    expect(reads).toEqual([
      archiveObjectKey(stream, 2),
      archiveObjectKey(stream, 5),
      archiveObjectKey(stream, 6),
    ]);
    expect(lists.at(-1)?.startAfter).toBe(archiveObjectKey(stream, 5));
  });

  it('starts after the anchor and lands on the checkpoint', async () => {
    const stream = uniqueStream('walk-anchor');
    const [anchor, checkpoint, head] = await archiveChain(stream, [3, 4, 9]);
    const { bucket, reads } = countingBucket();

    expect(
      await walkStream(bucket, { stream, from: anchor, checkpoint, head, budget: 10 })
    ).toEqual({ kind: 'done', position: head, objects: 2 });
    expect(reads).toEqual([archiveObjectKey(stream, 4), archiveObjectKey(stream, 9)]);
  });

  it('fails when the checkpoint sequence falls inside an object', async () => {
    const stream = uniqueStream('walk-unaligned');
    const [, head] = await archiveChain(stream, [2, 5]);

    expect(
      await walkStream(env.AUDIT_ARCHIVE, {
        stream,
        from: { seq: 0, hash: GENESIS_HASH },
        checkpoint: { seq: 4, hash: head.hash },
        head,
        budget: 10,
      })
    ).toMatchObject({ kind: 'failed', reason: 'checkpoint_mismatch' });
  });

  it('fails when the chain lands on the checkpoint with another hash', async () => {
    const stream = uniqueStream('walk-mismatch');
    const [checkpoint, head] = await archiveChain(stream, [2, 5]);

    expect(
      await walkStream(env.AUDIT_ARCHIVE, {
        stream,
        from: { seq: 0, hash: GENESIS_HASH },
        checkpoint: { seq: checkpoint.seq, hash: 'b'.repeat(64) },
        head,
        budget: 10,
      })
    ).toMatchObject({ kind: 'failed', reason: 'checkpoint_mismatch' });
  });

  it('fails when the archive ends below the registry head', async () => {
    const stream = uniqueStream('walk-short');
    const [head] = await archiveChain(stream, [2]);

    expect(
      await walkStream(env.AUDIT_ARCHIVE, {
        stream,
        from: { seq: 0, hash: GENESIS_HASH },
        checkpoint: null,
        head: { seq: 7, hash: head.hash },
        budget: 10,
      })
    ).toMatchObject({ kind: 'failed', reason: 'head' });
  });
});
