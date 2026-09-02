/**
 * Unit tests for auto-commit branch protection and upstream branch bypass.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { createKiloClient } from '@kilocode/sdk';
import { runAutoCommit, type AutoCommitOptions } from '../../../wrapper/src/auto-commit.js';
import { createWrapperKiloClient, type WrapperKiloClient } from '../../../wrapper/src/kilo-api.js';
import type * as Utils from '../../../wrapper/src/utils.js';

// ---------------------------------------------------------------------------
// Mock the utils module (spawns git processes + writes log files)
// ---------------------------------------------------------------------------

vi.mock('../../../wrapper/src/utils.js', async () => {
  const actual = await vi.importActual<typeof Utils>('../../../wrapper/src/utils.js');
  return {
    ...actual,
    git: vi.fn(),
    getCurrentBranch: vi.fn(),
    hasGitUpstream: vi.fn(),
    logToFile: vi.fn(),
  };
});

// Import mocked functions so we can configure per-test return values
import {
  git,
  getCurrentBranch,
  hasGitUpstream,
  logToFile,
  withTimeoutAndAbort,
} from '../../../wrapper/src/utils.js';

const mockGetCurrentBranch = vi.mocked(getCurrentBranch);
const mockHasGitUpstream = vi.mocked(hasGitUpstream);
const mockGit = vi.mocked(git);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ok = (stdout = '', stderr = ''): Utils.ExecResult => ({ stdout, stderr, exitCode: 0 });

const createMockKiloClient = (): WrapperKiloClient => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
  sendPromptAsync: vi.fn(),
  abortSession: vi.fn(),
  summarizeSession: vi.fn(),
  sendCommand: vi.fn(),
  answerPermission: vi.fn(),
  answerQuestion: vi.fn(),
  rejectQuestion: vi.fn(),
  getSessionStatuses: vi.fn(),
  getQuestions: vi.fn(),
  getPermissions: vi.fn(),
  getNetworkWaits: vi.fn(),
  resumeNetworkWait: vi.fn(),
  generateCommitMessage: vi.fn().mockResolvedValue({ message: 'test commit' }),
  getSessionStatuses: vi.fn().mockResolvedValue({}),
  getQuestions: vi.fn().mockResolvedValue([]),
  getPermissions: vi.fn().mockResolvedValue([]),
  subscribeEvents: vi.fn().mockResolvedValue({ stream: undefined }),
  serverUrl: 'http://127.0.0.1:0',
});

type EmittedEvent = { streamEventType: string; data: Record<string, unknown> };

function createOpts(overrides: Partial<AutoCommitOptions> = {}): {
  opts: AutoCommitOptions;
  events: EmittedEvent[];
} {
  const events: EmittedEvent[] = [];
  const opts: AutoCommitOptions = {
    workspacePath: '/workspace',
    onEvent: event => events.push(event as unknown as EmittedEvent),
    kiloClient: createMockKiloClient(),
    ...overrides,
  };
  return { opts, events };
}

function blockCommitMessageRequest() {
  const received = Promise.withResolvers<Request>();
  const response = Promise.withResolvers<Response>();
  vi.stubGlobal(
    'fetch',
    vi.fn((request: Request) => {
      request.signal.throwIfAborted();
      received.resolve(request);
      request.signal.addEventListener('abort', () => response.reject(request.signal.reason), {
        once: true,
      });
      return response.promise;
    })
  );
  const serverUrl = 'http://127.0.0.1:0';
  return {
    received: received.promise,
    response,
    kiloClient: createWrapperKiloClient(
      createKiloClient({ baseUrl: serverUrl }),
      serverUrl,
      '/workspace'
    ),
  };
}

/** Configure mocks for a full happy-path commit+push (from git status onward). */
function setupHappyPathGit(): void {
  // git status --porcelain  →  has changes
  // git add -A              →  ok
  // git commit -m ...       →  ok
  // git rev-parse --short HEAD  →  abc1234
  // git push ...            →  ok
  mockGit
    .mockResolvedValueOnce(ok(' M file.ts')) // status
    .mockResolvedValueOnce(ok()) // add
    .mockResolvedValueOnce(ok('[main abc1234] test commit')) // commit
    .mockResolvedValueOnce(ok('abc1234')) // rev-parse
    .mockResolvedValueOnce(ok()); // push
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runAutoCommit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasGitUpstream.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // Detached HEAD
  // -------------------------------------------------------------------------

  it('skips on detached HEAD', async () => {
    mockGetCurrentBranch.mockResolvedValue('');

    const { opts, events } = createOpts();
    const result = await runAutoCommit(opts);

    expect(result).toEqual({ success: true, skipped: true });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        streamEventType: 'autocommit_completed',
        data: expect.objectContaining({ skipped: true, message: 'Skipped: detached HEAD state' }),
      })
    );
  });

  it('does not report aborted branch detection as detached HEAD', async () => {
    mockGetCurrentBranch.mockRejectedValue(new Error('git branch aborted'));

    const { opts, events } = createOpts();
    const result = await runAutoCommit(opts);

    expect(result).toEqual({ success: false, error: 'git branch aborted' });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        streamEventType: 'autocommit_completed',
        data: expect.objectContaining({
          success: false,
          message: 'Auto-commit failed: git branch aborted',
        }),
      })
    );
    expect(mockGit).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Protected branch — no upstreamBranch
  // -------------------------------------------------------------------------

  it('skips on main when no upstreamBranch is set', async () => {
    mockGetCurrentBranch.mockResolvedValue('main');

    const { opts, events } = createOpts();
    const result = await runAutoCommit(opts);

    expect(result).toEqual({ success: true, skipped: true });
    expect(events[0]).toEqual(
      expect.objectContaining({
        streamEventType: 'autocommit_completed',
        data: expect.objectContaining({ message: 'Skipped: cannot commit to main' }),
      })
    );
    // Should NOT call git status (bailed before reaching it)
    expect(mockGit).not.toHaveBeenCalled();
  });

  it('skips on master when no upstreamBranch is set', async () => {
    mockGetCurrentBranch.mockResolvedValue('master');

    const { opts, events } = createOpts();
    const result = await runAutoCommit(opts);

    expect(result).toEqual({ success: true, skipped: true });
    expect(events[0]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ message: 'Skipped: cannot commit to master' }),
      })
    );
  });

  // -------------------------------------------------------------------------
  // Protected branch — upstreamBranch does NOT match current branch
  // -------------------------------------------------------------------------

  it('skips on main when upstreamBranch is a different branch', async () => {
    mockGetCurrentBranch.mockResolvedValue('main');

    const { opts, events } = createOpts({ upstreamBranch: 'feature/test' });
    const result = await runAutoCommit(opts);

    expect(result).toEqual({ success: true, skipped: true });
    expect(events[0]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ message: 'Skipped: cannot commit to main' }),
      })
    );
    expect(mockGit).not.toHaveBeenCalled();
  });

  it('skips on master when upstreamBranch is a different branch', async () => {
    mockGetCurrentBranch.mockResolvedValue('master');

    const { opts, events } = createOpts({ upstreamBranch: 'develop' });
    const result = await runAutoCommit(opts);

    expect(result).toEqual({ success: true, skipped: true });
    expect(events[0]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ message: 'Skipped: cannot commit to master' }),
      })
    );
  });

  // -------------------------------------------------------------------------
  // Protected branch — upstreamBranch MATCHES current branch → bypass
  // -------------------------------------------------------------------------

  it('allows commit to main when upstreamBranch is main', async () => {
    mockGetCurrentBranch.mockResolvedValue('main');
    setupHappyPathGit();

    const { opts, events } = createOpts({ upstreamBranch: 'main' });
    const result = await runAutoCommit(opts);

    expect(result).toEqual({ success: true });
    // Should have emitted autocommit_started and autocommit_completed (success)
    const completed = events.find(e => e.streamEventType === 'autocommit_completed');
    expect(completed?.data).toEqual(
      expect.objectContaining({ success: true, message: 'Changes committed and pushed' })
    );
  });

  it('allows commit to master when upstreamBranch is master', async () => {
    mockGetCurrentBranch.mockResolvedValue('master');
    setupHappyPathGit();

    const { opts, events } = createOpts({ upstreamBranch: 'master' });
    const result = await runAutoCommit(opts);

    expect(result).toEqual({ success: true });
    const completed = events.find(e => e.streamEventType === 'autocommit_completed');
    expect(completed?.data).toEqual(
      expect.objectContaining({ success: true, message: 'Changes committed and pushed' })
    );
  });

  // -------------------------------------------------------------------------
  // No uncommitted changes
  // -------------------------------------------------------------------------

  it('skips when there are no uncommitted changes', async () => {
    mockGetCurrentBranch.mockResolvedValue('feature/foo');
    mockGit.mockResolvedValueOnce(ok('')); // git status --porcelain → empty

    const { opts, events } = createOpts();
    const result = await runAutoCommit(opts);

    expect(result).toEqual({ success: true, skipped: true });
    expect(events[0]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ message: 'No uncommitted changes' }),
      })
    );
  });

  // -------------------------------------------------------------------------
  // Happy path on a regular feature branch
  // -------------------------------------------------------------------------

  it('commits and pushes on a feature branch', async () => {
    mockGetCurrentBranch.mockResolvedValue('feature/cool-stuff');
    setupHappyPathGit();

    const { opts, events } = createOpts();
    const result = await runAutoCommit(opts);

    expect(result).toEqual({ success: true });
    const completed = events.find(e => e.streamEventType === 'autocommit_completed');
    expect(completed?.data).toEqual(
      expect.objectContaining({
        success: true,
        message: 'Changes committed and pushed',
        commitHash: 'abc1234',
        commitMessage: 'test commit',
      })
    );
  });

  it('appends the supplied co-author trailer to generated commit messages', async () => {
    mockGetCurrentBranch.mockResolvedValue('feature/cool-stuff');
    setupHappyPathGit();
    const commitMessage =
      'test commit\n\nCo-authored-by: kiloconnect[bot] <240665456+kiloconnect[bot]@users.noreply.github.com>';

    const { opts, events } = createOpts({
      commitCoAuthor: {
        name: 'kiloconnect[bot]',
        email: '240665456+kiloconnect[bot]@users.noreply.github.com',
      },
    });
    const result = await runAutoCommit(opts);

    expect(result).toEqual({ success: true });
    expect(mockGit).toHaveBeenNthCalledWith(
      3,
      ['commit', '-m', commitMessage],
      expect.objectContaining({ cwd: '/workspace', timeoutMs: 30_000 })
    );
    const completed = events.find(e => e.streamEventType === 'autocommit_completed');
    expect(completed?.data).toEqual(expect.objectContaining({ commitMessage }));
  });

  it.each([false, true])(
    'aborts the generation request on its deadline and commits the fallback with a caller signal=%s',
    async withCallerSignal => {
      vi.useFakeTimers();
      try {
        mockGetCurrentBranch.mockResolvedValue('feature/cool-stuff');
        setupHappyPathGit();
        const { kiloClient, received } = blockCommitMessageRequest();
        const controller = new AbortController();
        const commitMessage =
          'wip\n\nCo-authored-by: kiloconnect[bot] <240665456+kiloconnect[bot]@users.noreply.github.com>';
        const { opts, events } = createOpts({
          kiloClient,
          signal: withCallerSignal ? controller.signal : undefined,
          commitCoAuthor: {
            name: 'kiloconnect[bot]',
            email: '240665456+kiloconnect[bot]@users.noreply.github.com',
          },
        });

        const resultPromise = runAutoCommit(opts);
        const request = await received;
        expect(request.method).toBe('POST');
        expect(new URL(request.url).pathname).toBe('/commit-message');
        await expect(request.json()).resolves.toEqual({ path: '/workspace' });
        await vi.advanceTimersByTimeAsync(29_999);
        expect(request.signal.aborted).toBe(false);
        expect(mockGit).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        const result = await resultPromise;

        expect(request.signal.aborted).toBe(true);
        expect(request.signal.reason).toEqual(new Error('Commit message generation timed out'));
        expect(controller.signal.aborted).toBe(false);
        expect(result).toEqual({ success: true });
        expect(mockGit).toHaveBeenNthCalledWith(
          3,
          ['commit', '-m', commitMessage],
          expect.objectContaining({ cwd: '/workspace', timeoutMs: 30_000, signal: opts.signal })
        );
        expect(mockGit).toHaveBeenLastCalledWith(
          ['push'],
          expect.objectContaining({ cwd: '/workspace', timeoutMs: 60_000, signal: opts.signal })
        );
        const completed = events.find(e => e.streamEventType === 'autocommit_completed');
        expect(completed?.data).toEqual(
          expect.objectContaining({
            success: true,
            message: 'Changes committed and pushed',
            commitHash: 'abc1234',
            commitMessage,
          })
        );
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it('commits wip when generation returns an HTTP error without caller cancellation', async () => {
    mockGetCurrentBranch.mockResolvedValue('feature/cool-stuff');
    setupHappyPathGit();
    const { kiloClient, received, response } = blockCommitMessageRequest();
    const { opts, events } = createOpts({ kiloClient });

    const pending = runAutoCommit(opts);
    const request = await received;
    response.resolve(Response.json({ message: 'generation failed' }, { status: 422 }));

    expect(await pending).toEqual({ success: true });
    expect(request.signal.aborted).toBe(false);
    const completed = events.find(event => event.streamEventType === 'autocommit_completed');
    expect(completed?.data.commitMessage).toBe('wip');
    expect(mockGit).toHaveBeenNthCalledWith(
      3,
      ['commit', '-m', 'wip'],
      expect.objectContaining({ cwd: '/workspace' })
    );
  });

  it('does not stage when caller cancellation races a successful generation response', async () => {
    mockGetCurrentBranch.mockResolvedValue('feature/cool-stuff');
    mockGit.mockResolvedValueOnce(ok(' M file.ts'));
    const { kiloClient, received, response } = blockCommitMessageRequest();
    const controller = new AbortController();
    const reason = new Error('Task cancelled');
    const { opts } = createOpts({ kiloClient, signal: controller.signal });

    const pending = runAutoCommit(opts);
    const request = await received;
    response.resolve(Response.json({ message: 'too late' }));
    controller.abort(reason);

    expect(await pending).toEqual({ success: false, error: 'Task cancelled' });
    expect(request.signal.reason).toBe(reason);
    expect(mockGit.mock.calls.map(([args]) => args)).toEqual([['status', '--porcelain']]);
  });

  it('reports aborted git status distinctly from timeout', async () => {
    mockGetCurrentBranch.mockResolvedValue('feature/cool-stuff');
    mockGit.mockResolvedValueOnce({
      stdout: '',
      stderr: 'exec aborted',
      exitCode: 124,
      terminationReason: 'abort',
    });

    const { opts, events } = createOpts();
    const result = await runAutoCommit(opts);

    expect(result).toEqual({ success: false, error: 'git status aborted' });
    expect(events[0]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ message: 'git status aborted' }),
      })
    );
  });

  it('redacts explicit worktree profile credentials from finalization failures and logs', async () => {
    const secret = 'explicit-profile-github-credential';
    mockGetCurrentBranch.mockResolvedValue('feature/worktree');
    mockGit
      .mockResolvedValueOnce(ok(' M file.ts'))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok('[feature/worktree abc1234] test commit'))
      .mockResolvedValueOnce(ok('abc1234'))
      .mockResolvedValueOnce({
        stdout: '',
        stderr: `remote: rejected credential ${secret}`,
        exitCode: 1,
      });
    const { opts, events } = createOpts({ env: { GH_TOKEN: secret } });

    await runAutoCommit(opts);

    expect(
      events.find(event => event.streamEventType === 'autocommit_completed')?.data.message
    ).toContain('push failed');
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(vi.mocked(logToFile).mock.calls)).not.toContain(secret);
  });

  it('redacts authenticated GitHub remotes from push failure events', async () => {
    mockGetCurrentBranch.mockResolvedValue('feature/cool-stuff');
    mockGit
      .mockResolvedValueOnce(ok(' M file.ts'))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok('[feature/cool-stuff abc1234] test commit'))
      .mockResolvedValueOnce(ok('abc1234'))
      .mockResolvedValueOnce({
        stdout: '',
        stderr:
          'fatal: unable to access https://x-access-token:user-secret@github.com/acme/repo.git',
        exitCode: 1,
      });

    const { opts, events } = createOpts();
    await runAutoCommit(opts);

    const completed = events.find(e => e.streamEventType === 'autocommit_completed');
    expect(completed?.data.message).toContain('https://[REDACTED]@github.com/acme/repo.git');
    expect(completed?.data.message).not.toContain('user-secret');
  });

  it('cancels queued auto-commit without releasing its predecessor or blocking other worktrees', async () => {
    const workspacePath = '/workspace/shared';
    const otherDirectory = '/workspace/other';
    const dirty = new Set([workspacePath, otherDirectory]);
    const pushing = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<Utils.ExecResult>();
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const first = createOpts({ workspacePath, signal: controllers[0].signal });
    const cancelled = createOpts({ workspacePath, signal: controllers[1].signal });
    const next = createOpts({ workspacePath, signal: controllers[2].signal });
    const other = createOpts({ workspacePath: otherDirectory });
    const pending: ReturnType<typeof runAutoCommit>[] = [];
    let firstSettled = false;
    let nextSettled = false;
    mockGetCurrentBranch.mockResolvedValue('work');
    mockGit.mockImplementation(async (args, options) => {
      const directory = options?.cwd ?? '';
      if (args[0] === 'status') return ok(dirty.has(directory) ? ' M result.txt\n' : '');
      if (args[0] === 'commit') dirty.delete(directory);
      if (args[0] === 'rev-parse') return ok('abc1234');
      if (args[0] === 'push' && directory === workspacePath) {
        pushing.resolve();
        return stopped.promise;
      }
      return ok();
    });
    try {
      const firstCommit = runAutoCommit(first.opts).then(result => {
        firstSettled = true;
        return result;
      });
      pending.push(firstCommit);
      await pushing.promise;
      const cancelledCommit = runAutoCommit(cancelled.opts);
      pending.push(cancelledCommit);
      controllers[1].abort(new Error('Queued finalization cancelled'));
      expect(
        await withTimeoutAndAbort(cancelledCommit, {
          timeoutMs: 1_000,
          timeoutMessage: 'Queued auto-commit cancellation waited for its predecessor',
          abortMessage: 'Test cancelled',
        })
      ).toEqual({ success: false, error: 'Queued finalization cancelled' });
      expect(cancelled.events).toEqual([
        expect.objectContaining({
          streamEventType: 'autocommit_completed',
          data: expect.objectContaining({ success: false }),
        }),
      ]);
      const nextCommit = runAutoCommit(next.opts).then(result => {
        nextSettled = true;
        return result;
      });
      const otherCommit = runAutoCommit(other.opts);
      pending.push(nextCommit, otherCommit);
      expect(
        await withTimeoutAndAbort(otherCommit, {
          timeoutMs: 1_000,
          timeoutMessage: 'Unrelated worktree auto-commit was blocked',
          abortMessage: 'Test cancelled',
        })
      ).toEqual({ success: true });
      expect(firstSettled).toBe(false);
      expect(nextSettled).toBe(false);
      expect(next.events).toEqual([]);

      controllers[0].abort(new Error('Running finalization cancelled'));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(firstSettled).toBe(false);
      expect(nextSettled).toBe(false);
      stopped.resolve({ ...ok(), exitCode: 124, terminationReason: 'abort' });
      await firstCommit;
      expect(await nextCommit).toEqual({ success: true, skipped: true });
      expect(cancelled.opts.kiloClient.generateCommitMessage).not.toHaveBeenCalled();
      expect(next.opts.kiloClient.generateCommitMessage).not.toHaveBeenCalled();
      expect(mockGetCurrentBranch.mock.calls.map(([directory]) => directory)).toEqual([
        workspacePath,
        otherDirectory,
        workspacePath,
      ]);
    } finally {
      for (const controller of controllers) controller.abort();
      stopped.resolve({ ...ok(), exitCode: 124, terminationReason: 'abort' });
      await Promise.allSettled(pending);
      mockGit.mockReset();
      mockGetCurrentBranch.mockReset();
      mockHasGitUpstream.mockReset();
    }
  });

  it.each([false, true])(
    'serializes same-worktree auto-commit through push with new sibling edits=%s',
    async siblingEdits => {
      const actual = await vi.importActual<typeof Utils>('../../../wrapper/src/utils.js');
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-worktree-autocommit-'));
      const workspacePath = path.join(root, 'workspace');
      const remote = path.join(root, 'remote.git');
      const home = path.join(root, 'home');
      const env = { PATH: process.env.PATH, HOME: home };
      const generating = Promise.withResolvers<void>();
      const generated = Promise.withResolvers<{ message: string }>();
      const pushing = Promise.withResolvers<void>();
      const pushed = Promise.withResolvers<void>();
      const controllers = [new AbortController(), new AbortController()];
      const pending: ReturnType<typeof runAutoCommit>[] = [];
      const first = createOpts({
        workspacePath,
        env,
        messageId: 'first',
        signal: controllers[0].signal,
      });
      const second = createOpts({
        workspacePath,
        env,
        messageId: 'second',
        signal: controllers[1].signal,
      });
      let secondSettled = false;
      vi.mocked(first.opts.kiloClient.generateCommitMessage).mockImplementation(() => {
        generating.resolve();
        return generated.promise;
      });
      mockGetCurrentBranch.mockImplementation(actual.getCurrentBranch);
      mockHasGitUpstream.mockImplementation(actual.hasGitUpstream);
      mockGit.mockImplementation(async (args, options) => {
        if (args[0] === 'push') {
          pushing.resolve();
          await pushed.promise;
        }
        return actual.git(args, options);
      });
      const git = async (args: string[]) => {
        const result = await actual.git(args, { cwd: workspacePath, env, inheritEnv: false });
        expect(result.exitCode).toBe(0);
        return result.stdout;
      };
      try {
        await fs.mkdir(workspacePath);
        await fs.mkdir(home);
        await git(['init', '--bare', remote]);
        await git(['init', '--initial-branch=work']);
        await git(['config', 'user.name', 'Test Agent']);
        await git(['config', 'user.email', 'test@example.com']);
        await git(['config', 'commit.gpgsign', 'false']);
        await git(['remote', 'add', 'origin', remote]);
        await fs.writeFile(path.join(workspacePath, 'result.txt'), 'shared changes\n');

        const firstCommit = runAutoCommit(first.opts);
        pending.push(firstCommit);
        await generating.promise;
        const secondCommit = runAutoCommit(second.opts).then(result => {
          secondSettled = true;
          return result;
        });
        pending.push(secondCommit);
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(mockGetCurrentBranch).toHaveBeenCalledTimes(1);
        expect(second.events).toEqual([]);
        expect(secondSettled).toBe(false);

        generated.resolve({ message: 'Commit shared changes' });
        await pushing.promise;
        expect(await git(['status', '--porcelain'])).toBe('');
        expect(mockGetCurrentBranch).toHaveBeenCalledTimes(1);
        expect(secondSettled).toBe(false);
        if (siblingEdits) {
          await fs.writeFile(path.join(workspacePath, 'sibling.txt'), 'later sibling changes\n');
        }
        pushed.resolve();
        expect(await firstCommit).toEqual({ success: true });
        expect(await secondCommit).toEqual(
          siblingEdits ? { success: true } : { success: true, skipped: true }
        );
        expect(
          second.events.find(event => event.streamEventType === 'autocommit_completed')?.data
        ).toMatchObject({ success: true, messageId: 'second' });
        if (siblingEdits) {
          expect(await git(['--git-dir', remote, 'show', 'refs/heads/work:sibling.txt'])).toBe(
            'later sibling changes\n'
          );
        } else {
          expect(second.events).toHaveLength(1);
          expect(second.events[0].data.skipped).toBe(true);
        }
        expect(await git(['--git-dir', remote, 'show', 'refs/heads/work:result.txt'])).toBe(
          'shared changes\n'
        );
        expect(
          (await git(['--git-dir', remote, 'rev-list', '--count', 'refs/heads/work'])).trim()
        ).toBe(siblingEdits ? '2' : '1');
      } finally {
        for (const controller of controllers) controller.abort();
        generated.resolve({ message: 'Commit shared changes' });
        pushed.resolve();
        await Promise.allSettled(pending);
        mockGit.mockReset();
        mockGetCurrentBranch.mockReset();
        mockHasGitUpstream.mockReset();
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  );

  it('commits and pushes with the isolated worktree environment instead of wrapper credentials', async () => {
    const actual = await vi.importActual<typeof Utils>('../../../wrapper/src/utils.js');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'worktree-autocommit-'));
    const workspacePath = path.join(root, 'workspace');
    const remote = path.join(root, 'remote.git');
    const home = path.join(root, 'home');
    const report = path.join(root, 'hook-env.json');
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      XDG_DATA_HOME: path.join(home, 'data'),
      KILOCODE_TOKEN: 'guest-worktree-alias',
      WORKTREE_ENV_REPORT: report,
    };
    vi.stubEnv('AUTOCOMMIT_PARENT_ONLY', 'wrapper-only-value');
    mockGit.mockImplementation(actual.git);
    mockGetCurrentBranch.mockImplementation(actual.getCurrentBranch);
    mockHasGitUpstream.mockImplementation(actual.hasGitUpstream);
    try {
      await fs.mkdir(workspacePath);
      await fs.mkdir(home);
      const git = async (args: string[]) => {
        const result = await actual.git(args, { cwd: workspacePath, env, inheritEnv: false });
        expect(result.exitCode).toBe(0);
        return result.stdout;
      };
      await git(['init', '--bare', remote]);
      await git(['init', '--initial-branch=work']);
      await git(['config', 'user.name', 'Test Agent']);
      await git(['config', 'user.email', 'test@example.com']);
      await git(['config', 'commit.gpgsign', 'false']);
      await git(['remote', 'add', 'origin', remote]);
      await fs.writeFile(path.join(workspacePath, 'result.txt'), 'contained finalization\n');
      const hook = `#!/bin/sh\nnode -e 'require("node:fs").writeFileSync(process.env.WORKTREE_ENV_REPORT, JSON.stringify({home:process.env.HOME,data:process.env.XDG_DATA_HOME,token:process.env.KILOCODE_TOKEN,parent:process.env.AUTOCOMMIT_PARENT_ONLY ?? null}))'\n`;
      await fs.writeFile(path.join(workspacePath, '.git', 'hooks', 'pre-commit'), hook, {
        mode: 0o755,
      });
      const { opts } = createOpts({ workspacePath, env });

      await expect(runAutoCommit(opts)).resolves.toEqual({ success: true });
      expect(JSON.parse(await fs.readFile(report, 'utf8'))).toEqual({
        home,
        data: env.XDG_DATA_HOME,
        token: env.KILOCODE_TOKEN,
        parent: null,
      });
      expect(await git(['--git-dir', remote, 'show', 'refs/heads/work:result.txt'])).toBe(
        'contained finalization\n'
      );
    } finally {
      vi.unstubAllEnvs();
      mockGit.mockReset();
      mockGetCurrentBranch.mockReset();
      mockHasGitUpstream.mockReset();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('aborts the generation request on caller cancellation without staging, committing, or pushing', async () => {
    vi.useFakeTimers();
    try {
      mockGetCurrentBranch.mockResolvedValue('feature/cool-stuff');
      mockGit.mockResolvedValue(ok());
      mockGit.mockResolvedValueOnce(ok(' M file.ts'));
      const controller = new AbortController();
      const reason = new Error('Task cancelled');
      const { kiloClient, received } = blockCommitMessageRequest();
      const { opts, events } = createOpts({ kiloClient, signal: controller.signal });

      const resultPromise = runAutoCommit(opts);
      const request = await received;
      expect(request.signal.aborted).toBe(false);
      controller.abort(reason);
      const result = await resultPromise;

      expect(request.signal.aborted).toBe(true);
      expect(request.signal.reason).toBe(reason);
      expect(result).toEqual({ success: false, error: 'Task cancelled' });
      expect(mockGit.mock.calls.map(([args]) => args)).toEqual([['status', '--porcelain']]);
      expect(events.map(event => event.data.message)).toEqual([
        'Generating commit message...',
        'Auto-commit failed: Task cancelled',
      ]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
