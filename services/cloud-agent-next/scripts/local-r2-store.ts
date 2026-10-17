import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import type { ArtifactObjectStore } from '../src/sandbox-control/runtime-artifact-store.js';

const exec = promisify(execFile);

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * A strict serialized create-only owner over `wrangler r2 object --local`.
 *
 * One exclusive lock file guards check-then-put, so a create-only write is never
 * treated as a free slot after a concurrent create. Only a confirmed missing
 * object reads as absence: a transport, config, or lock error propagates.
 *
 * Shared by the runtime-upgrade driver and the cold-local preparation tooling so
 * the create-only publication rule has one owner.
 */
export function serializedLocalStore(options: {
  bucket: string;
  /** Repo/service root that owns the local Wrangler persistence. */
  serviceRoot: string;
  /** Scratch directory for the lock and object files. */
  tempDir: string;
  persistTo?: string;
}): ArtifactObjectStore {
  const { bucket, serviceRoot, tempDir } = options;
  const lock = path.join(tempDir, 'publish.lock');
  const flags = options.persistTo === undefined ? [] : ['--persist-to', options.persistTo];

  const readKey = async (key: string): Promise<Uint8Array | null> => {
    await fs.mkdir(tempDir, { recursive: true });
    const file = path.join(tempDir, 'read.obj');
    await fs.rm(file, { force: true });
    try {
      await exec(
        'pnpm',
        [
          'exec',
          'wrangler',
          'r2',
          'object',
          'get',
          `${bucket}/${key}`,
          '--local',
          `--file=${file}`,
          ...flags,
        ],
        { cwd: serviceRoot }
      );
    } catch (error) {
      const detail = `${(error as { stderr?: string }).stderr ?? ''}${(error as Error).message ?? ''}`;
      // Only a confirmed missing object is absence. A transport, config, or lock
      // error must propagate so a create-only write is never treated as a free slot.
      if (/specified key does not exist|nosuchkey|\b404\b/i.test(detail)) return null;
      throw error;
    }
    return fsSync.existsSync(file) ? new Uint8Array(await fs.readFile(file)) : null;
  };

  return {
    async putIfAbsent(key, bytes) {
      await fs.mkdir(tempDir, { recursive: true });
      for (;;) {
        let handle;
        try {
          handle = await fs.open(lock, 'wx');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          await sleep(50);
          continue;
        }
        try {
          if ((await readKey(key)) !== null) return false;
          const file = path.join(tempDir, `${sha256(bytes)}.obj`);
          await fs.writeFile(file, bytes);
          await exec(
            'pnpm',
            [
              'exec',
              'wrangler',
              'r2',
              'object',
              'put',
              `${bucket}/${key}`,
              '--local',
              `--file=${file}`,
              ...flags,
            ],
            { cwd: serviceRoot }
          );
          return true;
        } finally {
          await handle.close();
          await fs.rm(lock, { force: true });
        }
      }
    },
    getBytes: readKey,
  };
}
