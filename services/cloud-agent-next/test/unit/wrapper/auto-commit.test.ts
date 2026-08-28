/**
 * Unit tests for auto-commit branch protection and upstream branch bypass.
 */

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
import { git, getCurrentBranch, hasGitUpstream } from '../../../wrapper/src/utils.js';

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
    expect(completed?.data.message).toContain('x-access-token:***@github.com');
    expect(completed?.data.message).not.toContain('user-secret');
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
