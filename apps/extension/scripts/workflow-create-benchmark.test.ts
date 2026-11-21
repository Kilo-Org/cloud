/* eslint-disable import/no-nodejs-modules -- Creates and inspects real profile directories. */
/* eslint-disable typescript/no-unsafe-type-assertion -- cleanupAttempt only calls close() on the context; a real BrowserContext needs a browser. */
import type { BrowserContext } from '@playwright/test';
import { access, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanupAttempt, CleanupBlockerError } from './workflow-create-benchmark.ts';

const operatorAction = 'delete the throwaway profile and revoke the Kilo session this run used';

/** A throwaway profile with the extension storage the CLI token would sit in. */
const makeProfileDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'kilo-bench-cleanup-test-'));
  await writeFile(join(dir, 'kilo-auth-storage.json'), '{"token":"placeholder"}');
  return dir;
};

/** Narrowed to the only member cleanupAttempt uses. */
const fakeContext = (close: () => Promise<void>): BrowserContext =>
  ({ close }) as unknown as BrowserContext;

/** 'present', 'ENOENT', or another access error code. */
const probe = async (path: string): Promise<string> => {
  try {
    await access(path);
    return 'present';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? 'unknown-error';
  }
};

/** The rejection reason, or null when the call resolves. */
const captureFailure = async (op: Promise<void>): Promise<unknown> => {
  try {
    await op;
    return null;
  } catch (error) {
    return error;
  }
};

const removeDir = async (dir: string): Promise<void> => {
  try {
    await chmod(dir, 0o700);
  } catch {
    // Already unreadable or gone; the recursive removal below is the cleanup.
  }
  await rm(dir, { force: true, recursive: true });
};

describe('benchmark cleanup', () => {
  it('deletes the profile after the context close exceeds its cap', async () => {
    const dir = await makeProfileDir();
    try {
      const beforeCleanup = await probe(dir);
      const neverSettles = Promise.withResolvers<void>().promise;
      const failure = await captureFailure(
        cleanupAttempt(
          fakeContext(() => neverSettles),
          dir,
          undefined,
          null,
          {
            settlementCapMs: 30,
          }
        )
      );

      expect(failure).toBeInstanceOf(CleanupBlockerError);
      const blocker = failure as CleanupBlockerError;
      expect(blocker.message.startsWith(operatorAction)).toBe(true);
      expect(blocker.message).toContain('context close exceeded the 30ms cleanup cap');
      expect({
        outcome: blocker.outcome,
        survivingProfilePath: blocker.survivingProfilePath,
      }).toStrictEqual({ outcome: 'browser-unsettled', survivingProfilePath: dir });
      const afterCleanup = await probe(dir);
      expect({ after: afterCleanup, before: beforeCleanup }).toStrictEqual({
        after: 'ENOENT',
        before: 'present',
      });
    } finally {
      await removeDir(dir);
    }
  });

  it('deletes the profile after a normal context close', async () => {
    const dir = await makeProfileDir();
    try {
      await cleanupAttempt(
        fakeContext(() => Promise.resolve()),
        dir,
        undefined,
        null
      );
      await expect(probe(dir), 'a settled close must still remove the profile').resolves.toBe(
        'ENOENT'
      );
    } finally {
      await removeDir(dir);
    }
  });

  it('reports the surviving profile when removal cannot finish', async () => {
    const dir = await makeProfileDir();
    try {
      const failure = await captureFailure(
        cleanupAttempt(undefined, dir, undefined, null, {
          removalCapMs: 10_000,
          // Privilege-independent failure: a root runner ignores file modes.
          removeProfile: () => Promise.reject(new Error('EACCES: permission denied, unlink')),
        })
      );

      expect(failure).toBeInstanceOf(CleanupBlockerError);
      const blocker = failure as CleanupBlockerError;
      expect(blocker.message.startsWith(operatorAction)).toBe(true);
      expect(blocker.outcome).toBe('profile-unverified');
      expect(blocker.survivingProfilePath).toBe(dir);
      const survivingProfile = await probe(dir);
      expect({ survivingProfile }).toStrictEqual({ survivingProfile: 'present' });
    } finally {
      await removeDir(dir);
    }
  });
});
