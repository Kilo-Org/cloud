import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AGENT_GID, AGENT_UID } from '../../../src/shared/runtime-environment.js';
import { createOwnedProcessScope } from '../control/owned-processes';
import { stopOwnedProcesses, transferAgentOwnership } from './cleanup';

function processAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2).trim()[0];
    return state !== 'Z' && state !== 'X' && state !== 'x';
  } catch {
    return false;
  }
}

async function expectProcessGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 40 && processAlive(pid); attempt += 1) {
    await Bun.sleep(50);
  }
  expect(processAlive(pid)).toBe(false);
}

function daemonScript(): string {
  return [
    'const {spawn}=require("node:child_process");',
    'const c=spawn("sleep",["60"],{detached:true,stdio:"ignore"});',
    'console.log(c.pid);',
    'c.unref();',
  ].join(' ');
}

async function spawnDaemon(scope: ReturnType<typeof createOwnedProcessScope>): Promise<number> {
  const child = scope.spawn('node', ['-e', daemonScript()], {});
  const pid = await new Promise<number>(resolve => {
    child.stdout.once('data', chunk => resolve(Number(String(chunk).trim())));
  });
  await new Promise<void>(resolve => child.once('close', () => resolve()));
  return pid;
}

describe('stopOwnedProcesses', () => {
  it('stops and disposes an owned process scope', async () => {
    const scope = {
      stopSpawned: vi.fn(async () => true),
      dispose: vi.fn(),
      releaseAbandoned: vi.fn(),
    };
    await stopOwnedProcesses(scope, 123);
    expect(scope.stopSpawned).toHaveBeenCalledWith(123);
    expect(scope.dispose).toHaveBeenCalledOnce();
    expect(scope.releaseAbandoned).not.toHaveBeenCalled();
  });

  it('fails the capture when setup processes cannot be stopped', async () => {
    const scope = {
      stopSpawned: vi.fn(async () => false),
      dispose: vi.fn(),
      releaseAbandoned: vi.fn(),
    };
    let failure: unknown;
    try {
      await stopOwnedProcesses(scope, 123);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('Setup processes could not be stopped');
    expect(scope.dispose).not.toHaveBeenCalled();
    expect(scope.releaseAbandoned).toHaveBeenCalledOnce();
  });

  it('kills a detached setup process group without cgroup delegation', async () => {
    const scope = createOwnedProcessScope();
    expect(await scope.captureSpawnBaseline()).toBe(true);
    const child = scope.spawn('sh', ['-c', 'sleep 60 & echo $!; wait'], {});
    const grandchild = await new Promise<number>(resolve => {
      child.stdout.once('data', chunk => resolve(Number(String(chunk).trim())));
    });

    await stopOwnedProcesses(scope, Date.now() + 5_000);

    await expectProcessGone(grandchild);
  });

  it('kills a setup descendant that daemonizes into a new group after its parent exits', async () => {
    const scope = createOwnedProcessScope();
    expect(await scope.captureSpawnBaseline()).toBe(true);
    const daemon = await spawnDaemon(scope);

    await stopOwnedProcesses(scope, Date.now() + 5_000);

    await expectProcessGone(daemon);
  });

  it('preserves unrelated processes captured in the baseline while stopping setup descendants', async () => {
    const unrelated = Bun.spawn(['sleep', '60'], { stdio: ['ignore', 'ignore', 'ignore'] });
    try {
      const scope = createOwnedProcessScope();
      expect(await scope.captureSpawnBaseline()).toBe(true);
      const daemon = await spawnDaemon(scope);

      await stopOwnedProcesses(scope, Date.now() + 5_000);

      expect(processAlive(unrelated.pid)).toBe(true);
      await expectProcessGone(daemon);
    } finally {
      unrelated.kill('SIGKILL');
      await unrelated.exited;
    }
  });

  it('refuses to stop without an explicit pre-spawn baseline', async () => {
    const scope = createOwnedProcessScope();
    const child = scope.spawn('sleep', ['60'], {});
    try {
      expect(await scope.stopSpawned(Date.now() + 2_000)).toBe(false);
    } finally {
      child.kill('SIGKILL');
    }
  });
});

describe('transferAgentOwnership', () => {
  it.skipIf(process.platform !== 'linux' || process.getuid?.() !== 0)(
    'gives the existing roots and only the platform homes to the agent account',
    async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'builder-ownership-'));
      try {
        const root = path.join(directory, 'workspace');
        await fs.mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
        await fs.writeFile(path.join(directory, 'store-file'), 'cached');
        await fs.link(
          path.join(directory, 'store-file'),
          path.join(root, 'node_modules', 'pkg', 'index.js')
        );
        await fs.symlink('pkg/index.js', path.join(root, 'node_modules', 'link'));
        const homes = path.join(directory, 'home');
        const platformHome = path.join(homes, 'a'.repeat(64));
        const imageHome = path.join(homes, 'ubuntu');
        await fs.mkdir(path.join(platformHome, '.cache'), { recursive: true });
        await fs.mkdir(imageHome);
        await fs.writeFile(path.join(imageHome, 'private'), 'image user data', { mode: 0o600 });
        await fs.symlink(imageHome, path.join(homes, 'b'.repeat(64)));

        await transferAgentOwnership(
          new AbortController().signal,
          [root, path.join(directory, 'missing')],
          homes
        );

        const owner = async (file: string) => {
          const stat = await fs.lstat(file);
          return { file: path.relative(directory, file), uid: stat.uid, gid: stat.gid };
        };
        for (const file of [
          root,
          path.join(root, 'node_modules'),
          path.join(root, 'node_modules/pkg'),
          path.join(root, 'node_modules/pkg/index.js'),
          path.join(root, 'node_modules/link'),
          platformHome,
          path.join(platformHome, '.cache'),
        ]) {
          expect(await owner(file)).toEqual({
            file: path.relative(directory, file),
            uid: AGENT_UID,
            gid: AGENT_GID,
          });
        }
        for (const file of [
          directory,
          homes,
          imageHome,
          path.join(imageHome, 'private'),
          path.join(homes, 'b'.repeat(64)),
        ]) {
          expect(await owner(file)).toEqual({
            file: path.relative(directory, file),
            uid: 0,
            gid: 0,
          });
        }
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
  );
});
