import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_AUTO_COMMIT_MESSAGE_BYTES,
  autoCommitRecordSchema,
} from '@kilocode/worker-utils/cloud-agent-commits';
import { immutableGit, MAX_COMMIT_MESSAGE_BYTES, readCommitObject } from './commit-objects.js';

const directories: string[] = [];
function run(directory: string, args: string[]): string {
  const result = Bun.spawnSync({
    cmd: ['git', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
    cwd: directory,
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0)
    throw new Error(`Fixture Git failed: ${args[0]}: ${result.stderr.toString()}`);
  return result.stdout.toString();
}
async function repo() {
  const directory = await mkdtemp(join(tmpdir(), 'commit-objects-'));
  directories.push(directory);
  run(directory, ['init', '-b', 'work']);
  return directory;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  );
});

describe('readCommitObject', () => {
  it.each([-1, 0, 1])(
    'matches the shared byte limit with an explicit truncation flag at offset %s',
    async offset => {
      expect(MAX_COMMIT_MESSAGE_BYTES).toBe(MAX_AUTO_COMMIT_MESSAGE_BYTES);
      const directory = await repo();
      const message = 'x'.repeat(MAX_AUTO_COMMIT_MESSAGE_BYTES + offset - 1) + '\n';
      await writeFile(join(directory, 'message'), message);
      run(directory, ['add', '-A']);
      run(directory, ['commit', '--cleanup=verbatim', '-F', 'message']);
      const hash = run(directory, ['rev-parse', 'HEAD']).trim();
      const metadata = await readCommitObject(directory, hash, { timeoutMs: 5_000 });
      expect(metadata.commitMessage).toBe(message.slice(0, MAX_AUTO_COMMIT_MESSAGE_BYTES));
      expect(metadata.commitMessageTruncated).toBe(offset > 0 ? true : undefined);
      expect(
        autoCommitRecordSchema.safeParse({
          ...metadata,
          commitHash: hash,
          userMessageId: 'user',
          messageId: 'assistant',
          pushStatus: 'pushed',
        }).success
      ).toBe(true);
    }
  );

  it('reads exact hook-independent object messages and bounds UTF-8 at 16 KiB', async () => {
    const directory = await repo();
    const message = 'Subject\n\n' + '漢'.repeat(MAX_COMMIT_MESSAGE_BYTES);
    await writeFile(join(directory, 'message'), message);
    run(directory, ['add', '-A']);
    run(directory, ['commit', '--cleanup=verbatim', '-F', 'message']);
    const hash = run(directory, ['rev-parse', 'HEAD']).trim();
    const metadata = await readCommitObject(directory, hash, { timeoutMs: 5_000 });
    expect(metadata.commitMessageTruncated).toBe(true);
    expect(Buffer.byteLength(metadata.commitMessage)).toBeLessThanOrEqual(MAX_COMMIT_MESSAGE_BYTES);
    expect(message.startsWith(metadata.commitMessage)).toBe(true);
    expect(metadata.commitMessage).not.toContain('�');
    expect(
      autoCommitRecordSchema.safeParse({
        ...metadata,
        commitHash: hash,
        userMessageId: 'user',
        messageId: 'assistant',
        pushStatus: 'pushed',
      }).success
    ).toBe(true);
    const raw = await immutableGit(directory, ['cat-file', 'commit', hash], {
      timeoutMs: 5_000,
      maxOutputBytes: 512 * 1024,
    });
    expect(raw.stdoutBytes?.toString()).toContain(message);
  });
});
