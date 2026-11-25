import { describe, expect, it } from 'vitest';
import {
  ArchiveConflictError,
  archiveObjectKey,
  readArchivedObject,
  writeArchivedBatch,
} from '../src/relay/archive';
import { GENESIS_HASH, chainHash } from '../src/relay/chain';
import { auditBatch, env, readArchived, uniqueStream } from './helpers';

/** A bucket that refuses every write, like the live bucket under a lock rule. */
function lockedBucket(base: R2Bucket) {
  return {
    put: async () => {
      throw new Error('The object is locked');
    },
    head: (key: string) => base.head(key),
    get: (key: string) => base.get(key),
    list: (options?: R2ListOptions) => base.list(options),
  };
}

describe('writeArchivedBatch', () => {
  it('writes one gzip object and treats a locked key with the same hash as success', async () => {
    const stream = uniqueStream('archive-same');
    const batch = auditBatch(1, 2, stream);
    const object = {
      batch,
      prevHash: GENESIS_HASH,
      hash: await chainHash(GENESIS_HASH, batch),
    };

    expect(await writeArchivedBatch(env.AUDIT_ARCHIVE, object)).toBe('written');
    expect(await writeArchivedBatch(lockedBucket(env.AUDIT_ARCHIVE), object)).toBe('existing');
    expect(await readArchived(stream, 2)).toEqual(object);
  });

  it('fails when the locked key holds a different hash', async () => {
    const stream = uniqueStream('archive-conflict');
    const batch = auditBatch(1, 2, stream);
    const hash = await chainHash(GENESIS_HASH, batch);
    await writeArchivedBatch(env.AUDIT_ARCHIVE, { batch, prevHash: GENESIS_HASH, hash });

    const different = { batch, prevHash: GENESIS_HASH, hash: 'f'.repeat(64) };
    await expect(writeArchivedBatch(lockedBucket(env.AUDIT_ARCHIVE), different)).rejects.toThrow(
      ArchiveConflictError
    );
    expect(await readArchived(stream, 2)).toEqual({ batch, prevHash: GENESIS_HASH, hash });
  });

  it('fails when the locked key holds an object that does not decode', async () => {
    const stream = uniqueStream('archive-corrupt');
    const batch = auditBatch(1, 2, stream);
    await env.AUDIT_ARCHIVE.put(archiveObjectKey(stream, 2), 'not a gzip frame');

    const object = { batch, prevHash: GENESIS_HASH, hash: await chainHash(GENESIS_HASH, batch) };
    await expect(writeArchivedBatch(lockedBucket(env.AUDIT_ARCHIVE), object)).rejects.toThrow(
      ArchiveConflictError
    );
    expect(await readArchivedObject(env.AUDIT_ARCHIVE, archiveObjectKey(stream, 2))).toMatchObject(
      { kind: 'corrupt' }
    );
  });
});
