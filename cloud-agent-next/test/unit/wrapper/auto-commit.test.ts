/**
 * Unit tests for auto-commit branch protection and upstream branch bypass.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { runAutoCommit, type AutoCommitOptions } from '../../../wrapper/src/auto-commit.js';
import type { WrapperKiloClient } from '../../../wrapper/src/kilo-api.js';
import type { ExecResult } from '../../../wrapper/src/utils.js';

// ---------------------------------------------------------------------------
// Mock the utils module (spawns git processes + writes log files)
// ---------------------------------------------------------------------------

vi.mock('../../../wrapper/src/utils.js', () => ({
  git: vi.fn(),
  getCurrentBranch: vi.fn(),
  hasGitUpstream: vi.fn(),
  logToFile: vi.fn(),
}));

// Import mocked functions so we can configure per-test return values
import { git, getCurrentBranch, hasGitUpstream } from '../../../wrapper/src/utils.js';

const mockGetCurrentBranch = vi.mocked(getCurrentBranch);
const mockHasGitUpstream = vi.mocked(hasGitUpstream);
const mockGit = vi.mocked(git);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ok = (stdout = '', stderr = ''): ExecResult => ({ stdout, stderr, exitCode: 0 });

const createMockKiloClient = (): WrapperKiloClient => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
  sendPromptAsync: vi.fn(),
  abortSession: vi.fn(),
  sendCommand: vi.fn(),
  answerPermission: vi.fn(),
  answerQuestion: vi.fn(),
  rejectQuestion: vi.fn(),
  generateCommitMessage: vi.fn().mockResolvedValue({ message: 'test commit' }),
  sdkClient: {} as WrapperKiloClient['sdkClient'],
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
});
