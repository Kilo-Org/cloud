import { it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyRuntimeSourceCheckout } from './runtime-source.js';

it('exact-SHA validation rejects dirty tracked files, untracked files and another commit', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-source-'));
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error('Test repository setup failed');
    return result.stdout.trim();
  };
  try {
    git(['init', '--quiet']);
    await fs.writeFile(path.join(root, 'source.ts'), 'original');
    git(['add', 'source.ts']);
    git([
      '-c',
      'user.name=Runtime Test',
      '-c',
      'user.email=runtime@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ]);
    const sha = git(['rev-parse', 'HEAD']);
    expect(() => verifyRuntimeSourceCheckout(sha, root)).not.toThrow();
    await fs.writeFile(path.join(root, 'source.ts'), 'changed');
    expect(() => verifyRuntimeSourceCheckout(sha, root)).toThrow('dirty');
    await fs.writeFile(path.join(root, 'source.ts'), 'original');
    await fs.writeFile(path.join(root, 'extra.ts'), 'untracked');
    expect(() => verifyRuntimeSourceCheckout(sha, root)).toThrow('dirty');
    await fs.rm(path.join(root, 'extra.ts'));
    expect(() => verifyRuntimeSourceCheckout('f'.repeat(40), root)).toThrow('exact SHA');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
