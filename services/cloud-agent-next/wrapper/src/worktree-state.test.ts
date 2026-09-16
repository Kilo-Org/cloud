import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureWorktreeState, restoreWorktreeState } from './worktree-state';
import { WORKTREE_STATE_MAX_UNTRACKED_FILES } from '../../src/shared/worktree-state';

const endpoint = { url: 'https://worker.test/worktree-state/usr/scope', grant: 'test-grant' };

// Deterministic identity so `git commit` works in a bare sandbox environment.
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
} as Record<string, string>;

function git(directory: string, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd: directory, env: gitEnv, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

function repository(root: string): string {
  const directory = path.join(root, 'repo');
  fs.mkdirSync(directory, { recursive: true });
  git(directory, 'init', '--quiet', '--initial-branch', 'main');
  fs.writeFileSync(path.join(directory, 'tracked.txt'), 'original\n');
  fs.writeFileSync(path.join(directory, '.gitignore'), 'ignored/\n');
  git(directory, 'add', '-A');
  git(directory, 'commit', '--quiet', '-m', 'initial');
  return directory;
}

/**
 * Stands in for the worker's R2-backed endpoint: PUT keeps the bundle in
 * memory, GET hands it back, so a capture and a restore can be run end to end.
 */
function transport() {
  const stored: { bundle?: Uint8Array } = {};
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    expect(input).toBe(endpoint.url);
    if (init?.method === 'PUT') {
      stored.bundle = new Uint8Array(init.body as ArrayBuffer);
      return new Response(null, { status: 204 });
    }
    if (!stored.bundle) return new Response('Not found', { status: 404 });
    return new Response(stored.bundle as BodyInit, { status: 200 });
  }) as typeof fetch;
  return { stored, restore: () => void (globalThis.fetch = original) };
}

let root: string;
let net: ReturnType<typeof transport>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-state-test-'));
  net = transport();
});

afterEach(() => {
  net.restore();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('worktree state capture and restore', () => {
  it('carries modified, staged, deleted and untracked files onto a fresh clone', async () => {
    const source = repository(root);
    fs.writeFileSync(path.join(source, 'tracked.txt'), 'edited\n');
    fs.writeFileSync(path.join(source, 'staged.txt'), 'staged\n');
    git(source, 'add', 'staged.txt');
    fs.writeFileSync(path.join(source, 'untracked.txt'), 'untracked\n');
    fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(source, 'nested', 'deep.txt'), 'deep\n');
    fs.mkdirSync(path.join(source, 'ignored'), { recursive: true });
    fs.writeFileSync(path.join(source, 'ignored', 'artifact.bin'), 'build output\n');

    const captured = await captureWorktreeState({ directory: source, endpoint, env: gitEnv });
    expect(captured).toMatchObject({ status: 'captured' });

    // A rebuilt sandbox: the same commit, none of the uncommitted work.
    const rebuilt = path.join(root, 'rebuilt');
    git(root, 'clone', '--quiet', source, rebuilt);

    const restored = await restoreWorktreeState({ directory: rebuilt, endpoint, env: gitEnv });
    expect(restored).toMatchObject({ status: 'restored' });
    expect(fs.readFileSync(path.join(rebuilt, 'tracked.txt'), 'utf8')).toBe('edited\n');
    expect(fs.readFileSync(path.join(rebuilt, 'staged.txt'), 'utf8')).toBe('staged\n');
    expect(fs.readFileSync(path.join(rebuilt, 'untracked.txt'), 'utf8')).toBe('untracked\n');
    expect(fs.readFileSync(path.join(rebuilt, 'nested', 'deep.txt'), 'utf8')).toBe('deep\n');
    // `.gitignore`d output is rebuilt by setup commands, not carried.
    expect(fs.existsSync(path.join(rebuilt, 'ignored', 'artifact.bin'))).toBe(false);
  });

  it('does not overwrite a restorable bundle with a conflicted worktree', async () => {
    const source = repository(root);
    fs.writeFileSync(path.join(source, 'tracked.txt'), 'edited\n');
    expect(await captureWorktreeState({ directory: source, endpoint, env: gitEnv })).toMatchObject({
      status: 'captured',
    });
    const restorable = net.stored.bundle;
    expect(restorable).toBeDefined();

    git(source, 'checkout', '-b', 'other');
    fs.writeFileSync(path.join(source, 'tracked.txt'), 'other\n');
    git(source, 'commit', '--quiet', '-am', 'other');
    git(source, 'checkout', '--quiet', 'main');
    fs.writeFileSync(path.join(source, 'tracked.txt'), 'main\n');
    git(source, 'commit', '--quiet', '-am', 'main');
    const merged = spawnSync('git', ['merge', '--no-edit', 'other'], {
      cwd: source,
      env: gitEnv,
      encoding: 'utf8',
    });
    expect(merged.status).not.toBe(0);

    expect(await captureWorktreeState({ directory: source, endpoint, env: gitEnv })).toEqual({
      status: 'skipped',
      reason: 'unmerged',
    });
    expect(net.stored.bundle).toBe(restorable);
  });

  it('captures a deletion so the restored worktree loses the file again', async () => {
    const source = repository(root);
    fs.rmSync(path.join(source, 'tracked.txt'));

    expect(await captureWorktreeState({ directory: source, endpoint, env: gitEnv })).toMatchObject({
      status: 'captured',
    });
    const rebuilt = path.join(root, 'rebuilt');
    git(root, 'clone', '--quiet', source, rebuilt);
    expect(await restoreWorktreeState({ directory: rebuilt, endpoint, env: gitEnv })).toMatchObject(
      { status: 'restored' }
    );
    expect(fs.existsSync(path.join(rebuilt, 'tracked.txt'))).toBe(false);
  });

  it('captures a clean worktree as a no-op restore rather than replaying stale work', async () => {
    const source = repository(root);
    fs.writeFileSync(path.join(source, 'tracked.txt'), 'edited\n');
    await captureWorktreeState({ directory: source, endpoint, env: gitEnv });

    // The agent commits the work; the next capture must supersede the old one.
    git(source, 'commit', '--quiet', '-am', 'second');
    expect(await captureWorktreeState({ directory: source, endpoint, env: gitEnv })).toMatchObject({
      status: 'captured',
      files: 0,
    });

    const rebuilt = path.join(root, 'rebuilt');
    git(root, 'clone', '--quiet', source, rebuilt);
    expect(await restoreWorktreeState({ directory: rebuilt, endpoint, env: gitEnv })).toMatchObject(
      { status: 'restored', files: 0 }
    );
    expect(fs.readFileSync(path.join(rebuilt, 'tracked.txt'), 'utf8')).toBe('edited\n');
    expect(
      spawnSync('git', ['status', '--porcelain'], {
        cwd: rebuilt,
        env: gitEnv,
        encoding: 'utf8',
      }).stdout
    ).toBe('');
  });

  it('leaves a worktree untouched when it sits on a different commit', async () => {
    const source = repository(root);
    fs.writeFileSync(path.join(source, 'tracked.txt'), 'edited\n');
    await captureWorktreeState({ directory: source, endpoint, env: gitEnv });

    const diverged = path.join(root, 'diverged');
    git(root, 'clone', '--quiet', source, diverged);
    fs.writeFileSync(path.join(diverged, 'other.txt'), 'other\n');
    git(diverged, 'add', '-A');
    git(diverged, 'commit', '--quiet', '-m', 'divergent');

    expect(
      await restoreWorktreeState({ directory: diverged, endpoint, env: gitEnv })
    ).toMatchObject({ status: 'skipped', reason: 'head_mismatch' });
    expect(fs.readFileSync(path.join(diverged, 'tracked.txt'), 'utf8')).toBe('original\n');
  });

  it('never clobbers a file the rebuild already produced', async () => {
    const source = repository(root);
    fs.writeFileSync(path.join(source, 'untracked.txt'), 'from capture\n');
    await captureWorktreeState({ directory: source, endpoint, env: gitEnv });

    const rebuilt = path.join(root, 'rebuilt');
    git(root, 'clone', '--quiet', source, rebuilt);
    fs.writeFileSync(path.join(rebuilt, 'untracked.txt'), 'from setup\n');

    expect(await restoreWorktreeState({ directory: rebuilt, endpoint, env: gitEnv })).toMatchObject(
      { status: 'restored', files: 0 }
    );
    expect(fs.readFileSync(path.join(rebuilt, 'untracked.txt'), 'utf8')).toBe('from setup\n');
  });

  it('does not follow an untracked symlink out of the worktree when capturing', async () => {
    const source = repository(root);
    const outside = path.join(root, 'outside-secret.txt');
    fs.writeFileSync(outside, 'secret\n');
    fs.symlinkSync(outside, path.join(source, 'link.txt'));

    expect(await captureWorktreeState({ directory: source, endpoint, env: gitEnv })).toMatchObject({
      status: 'captured',
      files: 0,
    });
    const bundle = Buffer.from(net.stored.bundle!).toString('binary');
    expect(bundle).not.toContain('secret');

    const rebuilt = path.join(root, 'rebuilt');
    git(root, 'clone', '--quiet', source, rebuilt);
    await restoreWorktreeState({ directory: rebuilt, endpoint, env: gitEnv });
    expect(fs.existsSync(path.join(rebuilt, 'link.txt'))).toBe(false);
  });

  it('refuses to write an untracked file through a symlinked directory', async () => {
    const source = repository(root);
    // A worktree whose captured layout puts a file under a directory that the
    // rebuilt checkout resolves outside the worktree.
    fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(source, 'nested', 'payload.txt'), 'payload\n');
    await captureWorktreeState({ directory: source, endpoint, env: gitEnv });

    const rebuilt = path.join(root, 'rebuilt');
    git(root, 'clone', '--quiet', source, rebuilt);
    const escape = path.join(root, 'escape');
    fs.mkdirSync(escape, { recursive: true });
    fs.symlinkSync(escape, path.join(rebuilt, 'nested'));

    expect(await restoreWorktreeState({ directory: rebuilt, endpoint, env: gitEnv })).toMatchObject(
      { status: 'restored', files: 0 }
    );
    expect(fs.existsSync(path.join(escape, 'payload.txt'))).toBe(false);
  });

  it('gives up on a worktree whose diff alone would not fit', async () => {
    const source = repository(root);
    // A tracked file far past the staged ceiling: the capture must abandon it
    // rather than spool the whole diff to the sandbox's disk.
    fs.writeFileSync(path.join(source, 'tracked.txt'), Buffer.alloc(80 * 1024 * 1024, 0x61));
    expect(await captureWorktreeState({ directory: source, endpoint, env: gitEnv })).toEqual({
      status: 'skipped',
      reason: 'too_large',
    });
    expect(net.stored.bundle).toBeUndefined();
  });

  it('refuses a bundle that expands past the staged ceiling', async () => {
    const source = repository(root);
    fs.writeFileSync(path.join(source, 'tracked.txt'), 'edited\n');
    await captureWorktreeState({ directory: source, endpoint, env: gitEnv });

    // A highly compressible bundle standing in for a decompression bomb.
    const bomb = path.join(root, 'bomb');
    fs.mkdirSync(bomb, { recursive: true });
    fs.writeFileSync(path.join(bomb, 'big.bin'), Buffer.alloc(80 * 1024 * 1024, 0));
    spawnSync('tar', ['czf', path.join(root, 'bomb.tar.gz'), '-C', bomb, 'big.bin']);
    net.stored.bundle = new Uint8Array(fs.readFileSync(path.join(root, 'bomb.tar.gz')));

    const rebuilt = path.join(root, 'rebuilt');
    git(root, 'clone', '--quiet', source, rebuilt);
    expect(await restoreWorktreeState({ directory: rebuilt, endpoint, env: gitEnv })).toEqual({
      status: 'skipped',
      reason: 'too_large',
    });
    expect(fs.readFileSync(path.join(rebuilt, 'tracked.txt'), 'utf8')).toBe('original\n');
  });

  it('leaves the worktree untouched when a setup change conflicts with the patch', async () => {
    const source = repository(root);
    fs.writeFileSync(path.join(source, 'tracked.txt'), 'agent edit\n');
    await captureWorktreeState({ directory: source, endpoint, env: gitEnv });

    // The rebuild's setup command rewrote the same tracked file, so the patch
    // cannot apply. The checkout must not be left half-patched or conflicted.
    const rebuilt = path.join(root, 'rebuilt');
    git(root, 'clone', '--quiet', source, rebuilt);
    fs.writeFileSync(path.join(rebuilt, 'tracked.txt'), 'setup output\n');

    expect(await restoreWorktreeState({ directory: rebuilt, endpoint, env: gitEnv })).toEqual({
      status: 'skipped',
      reason: 'patch_failed',
    });
    const content = fs.readFileSync(path.join(rebuilt, 'tracked.txt'), 'utf8');
    expect(content).toBe('setup output\n');
    expect(content).not.toContain('<<<<<<<');
    // No unmerged index entries were left behind either.
    const status = spawnSync('git', ['status', '--porcelain'], {
      cwd: rebuilt,
      env: gitEnv,
      encoding: 'utf8',
    }).stdout;
    expect(status).toBe(' M tracked.txt\n');
    expect(status).not.toContain('UU');
  });

  it('skips a worktree carrying more untracked files than a bundle may hold', async () => {
    const source = repository(root);
    const many = path.join(source, 'generated');
    fs.mkdirSync(many, { recursive: true });
    for (let index = 0; index <= WORKTREE_STATE_MAX_UNTRACKED_FILES; index += 1) {
      fs.writeFileSync(path.join(many, `f${index}.txt`), 'x');
    }
    expect(await captureWorktreeState({ directory: source, endpoint, env: gitEnv })).toEqual({
      status: 'skipped',
      reason: 'too_many_files',
    });
    expect(net.stored.bundle).toBeUndefined();
  });

  it('degrades to a skip rather than throwing when the capture budget is spent', async () => {
    const source = repository(root);
    fs.writeFileSync(path.join(source, 'untracked.txt'), 'work\n');
    // The caller awaits this before emitting the turn outcome, so an expired
    // budget must never surface as a rejection.
    const spent = AbortSignal.abort();
    expect(
      await captureWorktreeState({ directory: source, endpoint, env: gitEnv, signal: spent })
    ).toMatchObject({ status: 'skipped' });
    expect(net.stored.bundle).toBeUndefined();
  });

  it('degrades to a skip when no temp directory can be created', async () => {
    const source = repository(root);
    fs.writeFileSync(path.join(source, 'tracked.txt'), 'edited\n');
    // Store a real bundle first, so the restore below fails on the temp
    // directory rather than trivially reporting an absent one.
    expect(await captureWorktreeState({ directory: source, endpoint, env: gitEnv })).toMatchObject({
      status: 'captured',
    });
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = path.join(root, 'no', 'such', 'place');
    try {
      // Neither side may reject: a capture rejection would strand the turn
      // without an outcome, and a restore rejection would fail the attach.
      expect(
        await captureWorktreeState({ directory: source, endpoint, env: gitEnv })
      ).toMatchObject({ status: 'skipped' });
      expect(await restoreWorktreeState({ directory: source, endpoint, env: gitEnv })).toEqual({
        status: 'skipped',
        reason: 'restore_failed',
      });
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
  });

  it('reports an absent bundle instead of failing the attach', async () => {
    const source = repository(root);
    expect(await restoreWorktreeState({ directory: source, endpoint, env: gitEnv })).toEqual({
      status: 'skipped',
      reason: 'absent',
    });
  });

  it('skips a directory that is not a git worktree', async () => {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain, { recursive: true });
    expect(await captureWorktreeState({ directory: plain, endpoint, env: gitEnv })).toEqual({
      status: 'skipped',
      reason: 'unreadable_head',
    });
  });

  it('reports an upload rejection without throwing', async () => {
    const source = repository(root);
    fs.writeFileSync(path.join(source, 'tracked.txt'), 'edited\n');
    globalThis.fetch = (async () =>
      new Response('Unauthorized', { status: 401 })) as unknown as typeof fetch;
    expect(await captureWorktreeState({ directory: source, endpoint, env: gitEnv })).toEqual({
      status: 'skipped',
      reason: 'upload_401',
    });
  });
});
