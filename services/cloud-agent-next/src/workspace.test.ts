import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  manageBranch,
  cloneGitHubRepo,
  cloneGitRepo,
  updateGitRemoteToken,
  checkDiskSpace,
  checkDiskAndCleanBeforeSetup,
  cleanupStaleWorkspaces,
  createSandboxUsageEvent,
  LOW_DISK_THRESHOLD_MB,
  STALE_DIR_MIN_AGE_SECONDS,
} from './workspace';
import type { ExecutionSession, SandboxInstance } from './types';

describe('manageBranch', () => {
  let fakeSession: ExecutionSession;
  let mockExec: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockExec = vi.fn();
    // Create a mock session with exec method
    fakeSession = {
      exec: mockExec,
    } as unknown as ExecutionSession;
  });

  describe('when branch exists in both local and remote', () => {
    it('should checkout session branch and pull leniently', async () => {
      mockExec
        .mockResolvedValueOnce({ exitCode: 0 }) // git fetch
        .mockResolvedValueOnce({ exitCode: 0 }) // local check (exists)
        .mockResolvedValueOnce({ exitCode: 0 }) // remote check (exists)
        .mockResolvedValueOnce({ exitCode: 0 }) // checkout
        .mockResolvedValueOnce({ exitCode: 0 }); // pull

      await manageBranch(fakeSession, '/workspace', 'feature/foo', false);

      const execCalls = mockExec.mock.calls;
      expect(execCalls[3]?.[0]).toContain("git checkout 'feature/foo'");
      expect(execCalls[4]?.[0]).toContain("git pull origin 'feature/foo'");
      expect(execCalls[4]?.[0]).not.toContain('--ff-only');
    });

    it('should checkout upstream branch without pulling', async () => {
      mockExec
        .mockResolvedValueOnce({ exitCode: 0 }) // git fetch
        .mockResolvedValueOnce({ exitCode: 0 }) // local check (exists)
        .mockResolvedValueOnce({ exitCode: 0 }) // remote check (exists)
        .mockResolvedValueOnce({ exitCode: 0 }); // checkout

      await manageBranch(fakeSession, '/workspace', 'main', true);

      const execCalls = mockExec.mock.calls;
      expect(execCalls[3]?.[0]).toContain("git checkout 'main'");
      // Verify NO pull occurs for upstream branches
      expect(mockExec).toHaveBeenCalledTimes(4); // only fetch + 2 checks + checkout
    });
  });

  describe('when branch exists only locally', () => {
    it('should checkout local branch without pulling', async () => {
      mockExec
        .mockResolvedValueOnce({ exitCode: 0 }) // git fetch
        .mockResolvedValueOnce({ exitCode: 0 }) // local check (exists)
        .mockResolvedValueOnce({ exitCode: 1 }) // remote check (does not exist)
        .mockResolvedValueOnce({ exitCode: 0 }); // checkout

      await manageBranch(fakeSession, '/workspace', 'feature/local', false);

      const execCalls = mockExec.mock.calls;
      expect(execCalls[3]?.[0]).toContain("git checkout 'feature/local'");
      // Verify pull was not called (should only be 4 calls total)
      expect(mockExec).toHaveBeenCalledTimes(4);
    });
  });

  describe('when branch exists only remotely', () => {
    it('should create tracking branch', async () => {
      mockExec
        .mockResolvedValueOnce({ exitCode: 0 }) // git fetch
        .mockResolvedValueOnce({ exitCode: 1 }) // local check (does not exist)
        .mockResolvedValueOnce({ exitCode: 0 }) // remote check (exists)
        .mockResolvedValueOnce({ exitCode: 0 }); // create tracking branch

      await manageBranch(fakeSession, '/workspace', 'feature/remote', false);

      const execCalls = mockExec.mock.calls;
      expect(execCalls[3]?.[0]).toContain(
        "git checkout -b 'feature/remote' 'origin/feature/remote'"
      );
    });
  });

  describe('when branch does not exist anywhere', () => {
    describe('and it is a session branch', () => {
      it('should create new local branch', async () => {
        mockExec
          .mockResolvedValueOnce({ exitCode: 0 }) // git fetch
          .mockResolvedValueOnce({ exitCode: 1 }) // local check (does not exist)
          .mockResolvedValueOnce({ exitCode: 1 }) // remote check (does not exist)
          .mockResolvedValueOnce({ exitCode: 0 }); // create new branch

        await manageBranch(fakeSession, '/workspace', 'session/123', false);

        const execCalls = mockExec.mock.calls;
        const createBranchCall = execCalls[3]?.[0] as string;
        expect(createBranchCall).toContain("git checkout -b 'session/123'");
        expect(createBranchCall).not.toContain('origin/');
      });
    });

    describe('and it is an upstream branch', () => {
      it('should fetch and checkout GitHub pull refs', async () => {
        mockExec
          .mockResolvedValueOnce({ exitCode: 0 }) // git fetch
          .mockResolvedValueOnce({ exitCode: 1 }) // local check (does not exist)
          .mockResolvedValueOnce({ exitCode: 1 }) // remote check (does not exist)
          .mockResolvedValueOnce({ exitCode: 0 }) // fetch pull ref
          .mockResolvedValueOnce({ exitCode: 0 }); // checkout from FETCH_HEAD

        const result = await manageBranch(fakeSession, '/workspace', 'refs/pull/42/head', true);

        const execCalls = mockExec.mock.calls;
        expect(execCalls[3]?.[0]).toContain("git fetch origin 'refs/pull/42/head'");
        expect(execCalls[4]?.[0]).toContain("git checkout -B 'refs/pull/42/head' FETCH_HEAD");
        expect(result).toBe('refs/pull/42/head');
      });

      it('should throw when pull ref fetch fails', async () => {
        mockExec
          .mockResolvedValueOnce({ exitCode: 0 }) // git fetch
          .mockResolvedValueOnce({ exitCode: 1 }) // local check (does not exist)
          .mockResolvedValueOnce({ exitCode: 1 }) // remote check (does not exist)
          .mockResolvedValueOnce({ exitCode: 1, stderr: 'fetch pull ref error' }); // fetch pull ref fails

        await expect(
          manageBranch(fakeSession, '/workspace', 'refs/pull/42/head', true)
        ).rejects.toThrow('Failed to fetch pull ref refs/pull/42/head');
      });

      it('should throw error', async () => {
        mockExec
          .mockResolvedValueOnce({ exitCode: 0 }) // git fetch
          .mockResolvedValueOnce({ exitCode: 1 }) // local check (does not exist)
          .mockResolvedValueOnce({ exitCode: 1 }); // remote check (does not exist)

        await expect(manageBranch(fakeSession, '/workspace', 'main', true)).rejects.toThrow(
          'Branch "main" not found in repository'
        );
      });
    });
  });

  describe('error handling', () => {
    it('should throw when checkout fails', async () => {
      mockExec
        .mockResolvedValueOnce({ exitCode: 0 }) // git fetch
        .mockResolvedValueOnce({ exitCode: 0 }) // local check (exists)
        .mockResolvedValueOnce({ exitCode: 0 }) // remote check (exists)
        .mockResolvedValueOnce({ exitCode: 1, stderr: 'checkout error' }); // checkout fails

      await expect(manageBranch(fakeSession, '/workspace', 'feature/foo', false)).rejects.toThrow(
        'Failed to checkout branch feature/foo'
      );
    });

    it('should throw when creating tracking branch fails', async () => {
      mockExec
        .mockResolvedValueOnce({ exitCode: 0 }) // git fetch
        .mockResolvedValueOnce({ exitCode: 1 }) // local check (does not exist)
        .mockResolvedValueOnce({ exitCode: 0 }) // remote check (exists)
        .mockResolvedValueOnce({ exitCode: 1, stderr: 'create error' }); // create tracking fails

      await expect(
        manageBranch(fakeSession, '/workspace', 'feature/remote', false)
      ).rejects.toThrow('Failed to create tracking branch feature/remote');
    });

    it('should warn but not throw when session branch pull fails', async () => {
      mockExec
        .mockResolvedValueOnce({ exitCode: 0 }) // git fetch
        .mockResolvedValueOnce({ exitCode: 0 }) // local check (exists)
        .mockResolvedValueOnce({ exitCode: 0 }) // remote check (exists)
        .mockResolvedValueOnce({ exitCode: 0 }) // checkout
        .mockResolvedValueOnce({
          exitCode: 1,
          stderr: 'CONFLICT (content): Merge conflict in file.txt',
        }); // pull fails

      // Should not throw for session branches - warnings are logged but we don't assert on them
      const result = await manageBranch(fakeSession, '/workspace', 'session/123', false);

      // Verify the function completed successfully despite the pull failure
      expect(result).toBe('session/123');
    });

    it('should continue when fetch fails', async () => {
      mockExec
        .mockResolvedValueOnce({ exitCode: 1, stderr: 'fetch error' }) // git fetch fails
        .mockResolvedValueOnce({ exitCode: 0 }) // local check (exists)
        .mockResolvedValueOnce({ exitCode: 1 }) // remote check (does not exist)
        .mockResolvedValueOnce({ exitCode: 0 }); // checkout

      const result = await manageBranch(fakeSession, '/workspace', 'feature/local', false);

      // Verify the function continued despite fetch failure and completed successfully
      const execCalls = mockExec.mock.calls;
      expect(execCalls[3]?.[0]).toContain("git checkout 'feature/local'");
      expect(result).toBe('feature/local');
    });
  });

  describe('edge cases', () => {
    it('should handle branch names with slashes and dashes', async () => {
      mockExec
        .mockResolvedValueOnce({ exitCode: 0 }) // git fetch
        .mockResolvedValueOnce({ exitCode: 0 }) // local check (exists)
        .mockResolvedValueOnce({ exitCode: 0 }) // remote check (exists)
        .mockResolvedValueOnce({ exitCode: 0 }) // checkout
        .mockResolvedValueOnce({ exitCode: 0 }); // pull

      await manageBranch(fakeSession, '/workspace', 'feature/add-new-api', false);

      const execCalls = mockExec.mock.calls;
      expect(execCalls[3]?.[0]).toContain("git checkout 'feature/add-new-api'");
    });
  });

  describe('pull strategy behavior', () => {
    it('should NOT pull for upstream branches', async () => {
      mockExec
        .mockResolvedValueOnce({ exitCode: 0 }) // git fetch
        .mockResolvedValueOnce({ exitCode: 0 }) // local check (exists)
        .mockResolvedValueOnce({ exitCode: 0 }) // remote check (exists)
        .mockResolvedValueOnce({ exitCode: 0 }); // checkout

      await manageBranch(fakeSession, '/workspace', 'develop', true);

      const execCalls = mockExec.mock.calls;
      expect(execCalls[3]?.[0]).toContain("git checkout 'develop'");
      // Verify NO pull occurs for upstream branches
      expect(mockExec).toHaveBeenCalledTimes(4); // only fetch + 2 checks + checkout
    });

    it('should NOT use --ff-only flag for session branches', async () => {
      mockExec
        .mockResolvedValueOnce({ exitCode: 0 }) // git fetch
        .mockResolvedValueOnce({ exitCode: 0 }) // local check (exists)
        .mockResolvedValueOnce({ exitCode: 0 }) // remote check (exists)
        .mockResolvedValueOnce({ exitCode: 0 }) // checkout
        .mockResolvedValueOnce({ exitCode: 0 }); // pull

      await manageBranch(fakeSession, '/workspace', 'session/456', false);

      const execCalls = mockExec.mock.calls;
      const pullCall = execCalls[4]?.[0] as string;
      expect(pullCall).toContain("git pull origin 'session/456'");
      expect(pullCall).not.toContain('--ff-only');
    });

    it('should succeed when branch is already up to date', async () => {
      mockExec
        .mockResolvedValueOnce({ exitCode: 0 }) // git fetch
        .mockResolvedValueOnce({ exitCode: 0 }) // local check (exists)
        .mockResolvedValueOnce({ exitCode: 0 }) // remote check (exists)
        .mockResolvedValueOnce({ exitCode: 0 }) // checkout
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'Already up to date.',
        }); // pull (no-op)

      const result = await manageBranch(fakeSession, '/workspace', 'feature/stable', false);

      expect(result).toBe('feature/stable');
    });
  });
});

describe('disk space checking', () => {
  let fakeSession: ExecutionSession;
  let mockExec: ReturnType<typeof vi.fn>;
  let mockGitCheckout: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockExec = vi.fn();
    mockGitCheckout = vi.fn();
    fakeSession = {
      exec: mockExec,
      gitCheckout: mockGitCheckout,
    } as unknown as ExecutionSession;
  });

  describe('checkDiskSpace direct', () => {
    it('should return DiskSpaceResult with low disk space', async () => {
      // 1024 MB in bytes, 10000 MB in bytes
      mockExec.mockResolvedValueOnce({
        exitCode: 0,
        stdout: '1073741824  10485760000\n',
        stderr: '',
      });

      const result = await checkDiskSpace(fakeSession);

      expect(result).toBeDefined();
      expect(result.availableMB).toBe(1024);
      expect(result.totalMB).toBe(10000);
      expect(result.isLow).toBe(true);
    });

    it('should return DiskSpaceResult with adequate disk space', async () => {
      // 5000 MB in bytes, 10000 MB in bytes
      mockExec.mockResolvedValueOnce({
        exitCode: 0,
        stdout: '5242880000  10485760000\n',
        stderr: '',
      });

      const result = await checkDiskSpace(fakeSession);

      expect(result).toBeDefined();
      expect(result.availableMB).toBe(5000);
      expect(result.totalMB).toBe(10000);
      expect(result.isLow).toBe(false);
    });

    it('should throw when df command fails', async () => {
      mockExec.mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'df: command not found',
      });

      await expect(checkDiskSpace(fakeSession)).rejects.toThrow('Disk check failed');
    });

    it('should throw when df output format is unexpected', async () => {
      mockExec.mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'unexpected output\n',
        stderr: '',
      });

      await expect(checkDiskSpace(fakeSession)).rejects.toThrow('Disk check failed');
    });
  });

  describe('createSandboxUsageEvent', () => {
    it('should create event with correct fields', async () => {
      // 3000 MB in bytes, 10000 MB in bytes
      mockExec.mockResolvedValueOnce({
        exitCode: 0,
        stdout: '3145728000  10485760000\n',
        stderr: '',
      });

      const event = await createSandboxUsageEvent(fakeSession, 'session-123');

      expect(event).toBeDefined();
      expect(event.streamEventType).toBe('sandbox-usage');
      expect(event.availableMB).toBe(3000);
      expect(event.totalMB).toBe(10000);
      expect(event.isLow).toBe(false);
      expect(event.timestamp).toBeDefined();
      expect(event.sessionId).toBe('session-123');
    });

    it('should set isLow to true when disk space is below threshold', async () => {
      // 1000 MB in bytes, 10000 MB in bytes
      mockExec.mockResolvedValueOnce({
        exitCode: 0,
        stdout: '1048576000  10485760000\n',
        stderr: '',
      });

      const event = await createSandboxUsageEvent(fakeSession, 'session-123');

      expect(event.isLow).toBe(true);
    });

    it('should throw when disk check fails', async () => {
      mockExec.mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'error',
      });

      await expect(createSandboxUsageEvent(fakeSession, 'session-123')).rejects.toThrow(
        'Disk check failed'
      );
    });
  });

  describe('cloneGitHubRepo', () => {
    it('should clone repository (disk space check is separate)', async () => {
      mockExec
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // git config user.name
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // git config user.email

      // Mock gitCheckout to succeed
      mockGitCheckout.mockResolvedValue({
        success: true,
        exitCode: 0,
      });

      await cloneGitHubRepo(fakeSession, '/workspace', 'org/repo');

      // Verify clone was called
      expect(mockGitCheckout).toHaveBeenCalled();
    });
  });

  describe('cloneGitRepo', () => {
    it('should clone repository (disk space check is separate)', async () => {
      mockExec
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // git config user.name
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // git config user.email

      // Mock gitCheckout to succeed
      mockGitCheckout.mockResolvedValue({
        success: true,
        exitCode: 0,
      });

      await cloneGitRepo(fakeSession, '/workspace', 'https://example.com/repo.git');

      // Verify clone was called
      expect(mockGitCheckout).toHaveBeenCalled();
    });

    it('should include token in URL when provided', async () => {
      mockExec
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // git config user.name
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // git config user.email

      // Mock gitCheckout to succeed
      mockGitCheckout.mockResolvedValue({
        success: true,
        exitCode: 0,
      });

      await cloneGitRepo(fakeSession, '/workspace', 'https://example.com/repo.git', 'test-token');

      // Verify gitCheckout was called with URL containing token
      expect(mockGitCheckout).toHaveBeenCalledWith(
        expect.stringContaining('x-access-token:test-token'),
        expect.any(Object)
      );
    });

    it('should use oauth2 username for gitlab platform', async () => {
      mockExec
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // git config user.name
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // git config user.email

      mockGitCheckout.mockResolvedValue({
        success: true,
        exitCode: 0,
      });

      await cloneGitRepo(
        fakeSession,
        '/workspace',
        'https://gitlab.com/repo.git',
        'test-token',
        undefined,
        {
          platform: 'gitlab',
        }
      );

      expect(mockGitCheckout).toHaveBeenCalledWith(
        expect.stringContaining('oauth2:test-token'),
        expect.any(Object)
      );
    });

    it('should use x-access-token username for github platform', async () => {
      mockExec
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // git config user.name
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // git config user.email

      mockGitCheckout.mockResolvedValue({
        success: true,
        exitCode: 0,
      });

      await cloneGitRepo(
        fakeSession,
        '/workspace',
        'https://example.com/repo.git',
        'test-token',
        undefined,
        {
          platform: 'github',
        }
      );

      expect(mockGitCheckout).toHaveBeenCalledWith(
        expect.stringContaining('x-access-token:test-token'),
        expect.any(Object)
      );
    });

    it('should use x-access-token username when platform is undefined', async () => {
      mockExec
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // git config user.name
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // git config user.email

      mockGitCheckout.mockResolvedValue({
        success: true,
        exitCode: 0,
      });

      await cloneGitRepo(fakeSession, '/workspace', 'https://example.com/repo.git', 'test-token');

      expect(mockGitCheckout).toHaveBeenCalledWith(
        expect.stringContaining('x-access-token:test-token'),
        expect.any(Object)
      );
    });
  });

  describe('updateGitRemoteToken', () => {
    it('should use oauth2 username for gitlab platform', async () => {
      mockExec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

      await updateGitRemoteToken(
        fakeSession,
        '/workspace',
        'https://gitlab.com/repo.git',
        'new-token',
        'gitlab'
      );

      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('oauth2:new-token'));
    });

    it('should use x-access-token username for github platform', async () => {
      mockExec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

      await updateGitRemoteToken(
        fakeSession,
        '/workspace',
        'https://example.com/repo.git',
        'new-token',
        'github'
      );

      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('x-access-token:new-token'));
    });

    it('should use x-access-token username when platform is undefined', async () => {
      mockExec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

      await updateGitRemoteToken(
        fakeSession,
        '/workspace',
        'https://example.com/repo.git',
        'new-token'
      );

      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('x-access-token:new-token'));
    });
  });

  describe('LOW_DISK_THRESHOLD_MB export', () => {
    it('should export threshold constant as 2048 (2GB)', () => {
      expect(LOW_DISK_THRESHOLD_MB).toBe(2048);
    });
  });

  describe('cleanupStaleWorkspaces', () => {
    let fakeSandbox: SandboxInstance;
    let mockSandboxExec: ReturnType<typeof vi.fn>;
    let mockListProcesses: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockSandboxExec = vi.fn();
      mockListProcesses = vi.fn();
      fakeSandbox = {
        exec: mockSandboxExec,
        listProcesses: mockListProcesses,
      } as unknown as SandboxInstance;
    });

    it('cleans up sessions with no running wrapper', async () => {
      const oldMtime = String(Math.floor(Date.now() / 1000) - STALE_DIR_MIN_AGE_SECONDS - 60);
      mockSandboxExec
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'agent_stale-1111\nagent_current-aaaa\n',
          stderr: '',
        }) // ls sessions/
        .mockResolvedValueOnce({ exitCode: 0, stdout: `${oldMtime}\n`, stderr: '' }) // stat agent_stale-1111
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // rm -rf workspace for stale session
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // rm -rf home for stale session

      mockListProcesses.mockResolvedValue([]);

      await cleanupStaleWorkspaces(fakeSandbox, '/workspace/org/user', 'agent_current-aaaa');

      // listProcesses is called exactly once (not per session)
      expect(mockListProcesses).toHaveBeenCalledTimes(1);

      const execCalls = mockSandboxExec.mock.calls.map((c: string[]) => c[0]);
      expect(execCalls[1]).toContain('stat');
      expect(execCalls[2]).toContain("rm -rf '/workspace/org/user/sessions/agent_stale-1111'");
      expect(execCalls[3]).toContain("rm -rf '/home/agent_stale-1111'");
    });

    it('skips the current session directory', async () => {
      mockSandboxExec.mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'agent_current-aaaa\n',
        stderr: '',
      });

      mockListProcesses.mockResolvedValue([]);

      await cleanupStaleWorkspaces(fakeSandbox, '/workspace/org/user', 'agent_current-aaaa');

      // Only the ls call — no rm calls
      expect(mockSandboxExec).toHaveBeenCalledTimes(1);
    });

    it('skips sessions that have a running wrapper', async () => {
      const oldMtime = String(Math.floor(Date.now() / 1000) - STALE_DIR_MIN_AGE_SECONDS - 60);
      mockSandboxExec
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'agent_active-bbbb\n',
          stderr: '',
        }) // ls sessions/
        .mockResolvedValueOnce({ exitCode: 0, stdout: `${oldMtime}\n`, stderr: '' }); // stat agent_active-bbbb

      mockListProcesses.mockResolvedValue([
        {
          id: 1,
          command: 'kilocode-wrapper --agent-session agent_active-bbbb WRAPPER_PORT=5001',
          status: 'running',
        },
      ]);

      await cleanupStaleWorkspaces(fakeSandbox, '/workspace/org/user', 'agent_current-aaaa');

      // ls + stat — no rm calls
      expect(mockSandboxExec).toHaveBeenCalledTimes(2);
    });

    it('returns early when sessions directory does not exist', async () => {
      mockSandboxExec.mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'No such file or directory',
      });

      await cleanupStaleWorkspaces(fakeSandbox, '/workspace/org/user', 'agent_current-aaaa');

      expect(mockSandboxExec).toHaveBeenCalledTimes(1);
      expect(mockListProcesses).not.toHaveBeenCalled();
    });

    it('returns early when sessions directory is empty', async () => {
      mockSandboxExec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

      await cleanupStaleWorkspaces(fakeSandbox, '/workspace/org/user', 'agent_current-aaaa');

      expect(mockSandboxExec).toHaveBeenCalledTimes(1);
      expect(mockListProcesses).not.toHaveBeenCalled();
    });

    it('continues cleaning remaining sessions when one throws', async () => {
      const oldMtime = String(Math.floor(Date.now() / 1000) - STALE_DIR_MIN_AGE_SECONDS - 60);
      mockSandboxExec
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'agent_stale-aaaa\nagent_stale-bbbb\n',
          stderr: '',
        }) // ls
        .mockRejectedValueOnce(new Error('exec threw during agent_stale-aaaa stat')) // stat throws for first session
        .mockResolvedValueOnce({ exitCode: 0, stdout: `${oldMtime}\n`, stderr: '' }) // stat agent_stale-bbbb
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // rm workspace agent_stale-bbbb
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // rm home agent_stale-bbbb

      mockListProcesses.mockResolvedValue([]);

      // Should not throw
      await expect(
        cleanupStaleWorkspaces(fakeSandbox, '/workspace/org/user', 'agent_current-aaaa')
      ).resolves.toBeUndefined();

      // listProcesses is called exactly once (not per session)
      expect(mockListProcesses).toHaveBeenCalledTimes(1);

      // second session was still attempted despite first throwing
      const execCalls = mockSandboxExec.mock.calls.map((c: string[]) => c[0]);
      expect(execCalls.some((c: string) => c.includes('agent_stale-bbbb'))).toBe(true);
    });

    it('does not throw when listProcesses rejects', async () => {
      mockSandboxExec.mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'agent_stale-1111\n',
        stderr: '',
      });
      mockListProcesses.mockRejectedValue(new Error('sandbox unavailable'));

      // Should not throw — returns early without cleaning any sessions
      await expect(
        cleanupStaleWorkspaces(fakeSandbox, '/workspace/org/user', 'agent_current-aaaa')
      ).resolves.toBeUndefined();

      // Only the ls call — no rm calls since listProcesses failed
      expect(mockSandboxExec).toHaveBeenCalledTimes(1);
    });

    it('does not throw when ls throws', async () => {
      mockSandboxExec.mockRejectedValueOnce(new Error('exec error'));

      await expect(
        cleanupStaleWorkspaces(fakeSandbox, '/workspace/org/user', 'agent_current-aaaa')
      ).resolves.toBeUndefined();
    });

    it('skips directory entries that do not match the agent_ session ID format', async () => {
      const oldMtime = String(Math.floor(Date.now() / 1000) - STALE_DIR_MIN_AGE_SECONDS - 60);
      mockSandboxExec
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'unexpected-dir\n.hidden\nlost+found\nagent_valid-1234\n',
          stderr: '',
        }) // ls
        .mockResolvedValueOnce({ exitCode: 0, stdout: `${oldMtime}\n`, stderr: '' }) // stat agent_valid-1234
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // rm workspace agent_valid-1234
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // rm home agent_valid-1234

      mockListProcesses.mockResolvedValue([]);

      await cleanupStaleWorkspaces(fakeSandbox, '/workspace/org/user', 'agent_current-aaaa');

      const execCalls = mockSandboxExec.mock.calls.map((c: string[]) => c[0]);
      // Non-matching entries never appear in any exec call after the ls
      expect(execCalls.every(c => !c.includes('unexpected-dir'))).toBe(true);
      expect(execCalls.every(c => !c.includes('.hidden'))).toBe(true);
      expect(execCalls.every(c => !c.includes('lost+found'))).toBe(true);
      // The valid session was cleaned up
      expect(execCalls.some(c => c.includes('agent_valid-1234'))).toBe(true);
    });

    it('skips directories younger than STALE_DIR_MIN_AGE_SECONDS', async () => {
      const recentMtime = String(Math.floor(Date.now() / 1000) - 30); // 30 seconds ago
      mockSandboxExec
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'agent_recent-1111\n',
          stderr: '',
        }) // ls sessions/
        .mockResolvedValueOnce({ exitCode: 0, stdout: `${recentMtime}\n`, stderr: '' }); // stat

      mockListProcesses.mockResolvedValue([]);

      await cleanupStaleWorkspaces(fakeSandbox, '/workspace/org/user', 'agent_current-aaaa');

      // ls + stat only — no rm calls
      expect(mockSandboxExec).toHaveBeenCalledTimes(2);
    });

    it('cleans old directories but skips recent ones in the same run', async () => {
      const oldMtime = String(Math.floor(Date.now() / 1000) - STALE_DIR_MIN_AGE_SECONDS - 60);
      const recentMtime = String(Math.floor(Date.now() / 1000) - 30);
      mockSandboxExec
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'agent_old-1111\nagent_recent-2222\n',
          stderr: '',
        }) // ls
        .mockResolvedValueOnce({ exitCode: 0, stdout: `${oldMtime}\n`, stderr: '' }) // stat agent_old-1111
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // rm workspace agent_old-1111
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // rm home agent_old-1111
        .mockResolvedValueOnce({ exitCode: 0, stdout: `${recentMtime}\n`, stderr: '' }); // stat agent_recent-2222

      mockListProcesses.mockResolvedValue([]);

      await cleanupStaleWorkspaces(fakeSandbox, '/workspace/org/user', 'agent_current-aaaa');

      const execCalls = mockSandboxExec.mock.calls.map((c: string[]) => c[0]);
      // Old session was cleaned
      expect(
        execCalls.some((c: string) =>
          c.includes("rm -rf '/workspace/org/user/sessions/agent_old-1111'")
        )
      ).toBe(true);
      // Recent session was NOT cleaned (no rm call containing agent_recent-2222)
      expect(
        execCalls.every((c: string) => !c.includes('rm') || !c.includes('agent_recent-2222'))
      ).toBe(true);
    });

    it('skips cleanup when stat fails (unknown age treated as recent)', async () => {
      mockSandboxExec
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'agent_stale-1111\n',
          stderr: '',
        }) // ls
        .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'stat: cannot stat' }); // stat fails

      mockListProcesses.mockResolvedValue([]);

      await cleanupStaleWorkspaces(fakeSandbox, '/workspace/org/user', 'agent_current-aaaa');

      // ls + stat only — no rm calls (directory was skipped)
      expect(mockSandboxExec).toHaveBeenCalledTimes(2);
    });

    it('skips cleanup when stat returns unparseable output', async () => {
      mockSandboxExec
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'agent_stale-1111\n',
          stderr: '',
        }) // ls
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'not-a-number\n', stderr: '' }); // stat returns garbage

      mockListProcesses.mockResolvedValue([]);

      await cleanupStaleWorkspaces(fakeSandbox, '/workspace/org/user', 'agent_current-aaaa');

      // ls + stat only — no rm calls (directory was skipped)
      expect(mockSandboxExec).toHaveBeenCalledTimes(2);
    });
  });

  describe('checkDiskAndCleanBeforeSetup', () => {
    let fakeSandbox: SandboxInstance;
    let mockSandboxExec: ReturnType<typeof vi.fn>;
    let mockListProcesses: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockSandboxExec = vi.fn();
      mockListProcesses = vi.fn();
      fakeSandbox = {
        exec: mockSandboxExec,
        listProcesses: mockListProcesses,
      } as unknown as SandboxInstance;
    });

    it('runs cleanup when disk space is low', async () => {
      const oldMtime = String(Math.floor(Date.now() / 1000) - STALE_DIR_MIN_AGE_SECONDS - 60);
      // df returns low disk (1024 MB avail, 10000 MB total)
      mockSandboxExec
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '1073741824  10485760000\n',
          stderr: '',
        }) // df (checkDiskSpace)
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: 'agent_stale-1111\nagent_current-aaaa\n',
          stderr: '',
        }) // ls sessions/ (cleanupStaleWorkspaces)
        .mockResolvedValueOnce({ exitCode: 0, stdout: `${oldMtime}\n`, stderr: '' }) // stat agent_stale-1111
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // rm workspace
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // rm home

      mockListProcesses.mockResolvedValue([]);

      await checkDiskAndCleanBeforeSetup(fakeSandbox, 'org-1', 'user-1', 'agent_current-aaaa');

      // df was called
      expect(mockSandboxExec.mock.calls[0][0]).toContain('df -B1');
      // ls was called to find sessions
      expect(mockSandboxExec.mock.calls[1][0]).toContain('ls -1');
      // stat was called for the stale session
      expect(mockSandboxExec.mock.calls[2][0]).toContain('stat');
      // stale session was cleaned
      expect(mockSandboxExec.mock.calls[3][0]).toContain('agent_stale-1111');
    });

    it('skips cleanup when disk space is adequate', async () => {
      // df returns adequate disk (5000 MB avail, 10000 MB total)
      mockSandboxExec.mockResolvedValueOnce({
        exitCode: 0,
        stdout: '5242880000  10485760000\n',
        stderr: '',
      });

      await checkDiskAndCleanBeforeSetup(fakeSandbox, 'org-1', 'user-1', 'agent_current-aaaa');

      // Only the df call — no cleanup
      expect(mockSandboxExec).toHaveBeenCalledTimes(1);
      expect(mockListProcesses).not.toHaveBeenCalled();
    });

    it('does not throw when disk check fails', async () => {
      mockSandboxExec.mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'df: command not found',
      });

      // Should not throw — logs and continues
      await expect(
        checkDiskAndCleanBeforeSetup(fakeSandbox, 'org-1', 'user-1', 'agent_current-aaaa')
      ).resolves.toBeUndefined();
    });

    it('does not throw when cleanup fails', async () => {
      // df returns low disk
      mockSandboxExec
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '1073741824  10485760000\n',
          stderr: '',
        })
        // ls throws
        .mockRejectedValueOnce(new Error('exec error'));

      // Should not throw — cleanupStaleWorkspaces catches internally
      await expect(
        checkDiskAndCleanBeforeSetup(fakeSandbox, 'org-1', 'user-1', 'agent_current-aaaa')
      ).resolves.toBeUndefined();
    });
  });
});
