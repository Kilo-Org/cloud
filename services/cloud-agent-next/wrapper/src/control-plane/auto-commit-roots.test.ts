import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IngestEvent } from '../../../src/shared/protocol.js';
import type { AutoCommitOptions } from '../auto-commit.js';
import type { WrapperKiloClient } from '../kilo-api.js';
import { git } from '../utils.js';
import { autoCommitRoots } from './auto-commit-roots.js';
import type { RouteRoot } from './workspace-roots.js';

const kiloClient = {
  generateCommitMessage: async () => ({ message: 'update' }),
} as unknown as WrapperKiloClient;

describe('autoCommitRoots with real repositories', () => {
  let temporary: string;
  let env: NodeJS.ProcessEnv;
  let events: IngestEvent[];

  beforeEach(async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-commit-roots-'));
    const home = path.join(temporary, 'home');
    await fs.mkdir(home);
    env = {
      PATH: process.env.PATH,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    };
    events = [];
  });

  afterEach(async () => {
    await fs.rm(temporary, { recursive: true, force: true });
  });

  async function run(cwd: string, args: string[]): Promise<string> {
    const result = await git(args, { cwd, env, inheritEnv: false });
    expect(result.exitCode).toBe(0);
    return result.stdout.trim();
  }

  /** A clone of a bare remote, on `branch`, with an uncommitted change. */
  async function dirtyRepository(
    leaf: string,
    branch: string
  ): Promise<{ directory: string; remote: string }> {
    const remote = path.join(temporary, `${leaf}.git`);
    const directory = path.join(temporary, 'workspace', leaf);
    await fs.mkdir(directory, { recursive: true });
    await run(directory, ['init', '--bare', remote]);
    await run(directory, ['init', `--initial-branch=${branch}`]);
    await run(directory, ['config', 'user.name', 'Test']);
    await run(directory, ['config', 'user.email', 'test@example.com']);
    await run(directory, ['config', 'commit.gpgsign', 'false']);
    await run(directory, ['remote', 'add', 'origin', remote]);
    await fs.writeFile(path.join(directory, 'a.txt'), `${leaf}\n`);
    return { directory, remote };
  }

  const options = (): Omit<AutoCommitOptions, 'workspacePath' | 'upstreamBranch'> => ({
    kiloClient,
    messageId: 'a1',
    userMessageId: 'u1',
    env,
    onEvent: event => events.push(event),
  });

  async function remoteHeads(remote: string): Promise<string> {
    return run(temporary, ['--git-dir', remote, 'branch', '--list']);
  }

  it('commits and pushes each root under its own branch rule', async () => {
    const web = await dirtyRepository('web', 'kilo/work');
    const api = await dirtyRepository('api', 'main');
    const roots: RouteRoot[] = [
      { directory: web.directory, repoFullName: 'acme/web', requestedBranch: undefined },
      { directory: api.directory, repoFullName: 'acme/api', requestedBranch: 'main' },
    ];

    const outcomes = await autoCommitRoots({ roots, options: options() });

    expect(outcomes.map(outcome => outcome.result)).toEqual([{ success: true }, { success: true }]);
    expect(await remoteHeads(web.remote)).toContain('kilo/work');
    expect(await remoteHeads(api.remote)).toContain('main');
    const completed = events.filter(event => event.streamEventType === 'autocommit_completed');
    expect(completed.map(event => (event.data as { repository?: string }).repository)).toEqual([
      'acme/web',
      'acme/api',
    ]);
    expect(completed.map(event => (event.data as { message: string }).message)).toEqual([
      'acme/web: Changes committed; push command completed',
      'acme/api: Changes committed; push command completed',
    ]);
  });

  it('protects main for a root whose branch was not requested', async () => {
    const web = await dirtyRepository('web', 'main');
    const api = await dirtyRepository('api', 'main');
    const roots: RouteRoot[] = [
      { directory: web.directory, repoFullName: 'acme/web', requestedBranch: undefined },
      { directory: api.directory, repoFullName: 'acme/api', requestedBranch: 'main' },
    ];

    await autoCommitRoots({ roots, options: options() });

    expect(await run(web.directory, ['status', '--porcelain'])).toContain('a.txt');
    expect(await remoteHeads(web.remote)).toBe('');
    expect(await remoteHeads(api.remote)).toContain('main');
  });
});

describe('autoCommitRoots result handling', () => {
  const roots: RouteRoot[] = [
    { directory: '/workspace/web', repoFullName: 'acme/web', requestedBranch: 'main' },
    { directory: '/workspace/api', repoFullName: 'acme/api', requestedBranch: undefined },
  ];

  it('runs the other roots after one root throws, and reports that root', async () => {
    const seen: string[] = [];
    const outcomes = await autoCommitRoots({
      roots,
      options: { kiloClient, onEvent: () => undefined },
      autoCommit: async opts => {
        seen.push(opts.workspacePath);
        if (opts.workspacePath === '/workspace/web') throw new Error('hook exploded');
        return { success: true };
      },
    });

    expect(seen).toEqual(['/workspace/web', '/workspace/api']);
    expect(outcomes[0]?.error).toBeInstanceOf(Error);
    expect(outcomes[1]?.result).toEqual({ success: true });
  });

  it('passes only an explicitly requested branch', async () => {
    const calls: AutoCommitOptions[] = [];
    await autoCommitRoots({
      roots,
      options: { kiloClient, onEvent: () => undefined },
      autoCommit: async opts => {
        calls.push(opts);
        return { success: true };
      },
    });

    expect(calls.map(call => [call.workspacePath, call.upstreamBranch])).toEqual([
      ['/workspace/web', 'main'],
      ['/workspace/api', undefined],
    ]);
    expect('upstreamBranch' in (calls[1] ?? {})).toBe(false);
  });

  it('stops after the first root once the turn is aborted', async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    const outcomes = await autoCommitRoots({
      roots,
      options: { kiloClient, onEvent: () => undefined, signal: controller.signal },
      autoCommit: async opts => {
        seen.push(opts.workspacePath);
        controller.abort();
        throw new Error('aborted');
      },
    });

    expect(seen).toEqual(['/workspace/web']);
    expect(outcomes).toHaveLength(1);
  });

  it('leaves the call and the events of a legacy root as they were', async () => {
    const legacy: RouteRoot = {
      directory: '/workspace/app',
      repoFullName: undefined,
      requestedBranch: undefined,
    };
    const emitted: IngestEvent[] = [];
    const calls: AutoCommitOptions[] = [];
    await autoCommitRoots({
      roots: [legacy],
      options: { kiloClient, messageId: 'a1', onEvent: event => emitted.push(event) },
      autoCommit: async opts => {
        calls.push(opts);
        opts.onEvent({
          streamEventType: 'autocommit_completed',
          data: { success: true, message: 'Changes committed', messageId: 'a1' },
          timestamp: '2026-10-28T00:00:00.000Z',
        });
        return { success: true };
      },
    });

    expect(Object.keys(calls[0] ?? {}).sort()).toEqual([
      'kiloClient',
      'messageId',
      'onEvent',
      'workspacePath',
    ]);
    expect(emitted).toEqual([
      {
        streamEventType: 'autocommit_completed',
        data: { success: true, message: 'Changes committed', messageId: 'a1' },
        timestamp: '2026-10-28T00:00:00.000Z',
      },
    ]);
  });
});
