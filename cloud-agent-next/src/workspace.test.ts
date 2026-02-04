import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  manageBranch,
  cloneGitHubRepo,
  cloneGitRepo,
  checkDiskSpace,
  createSandboxUsageEvent,
  LOW_DISK_THRESHOLD_MB,
} from './workspace';
import type { ExecutionSession } from './types';

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
  });

  describe('LOW_DISK_THRESHOLD_MB export', () => {
    it('should export threshold constant as 2048 (2GB)', () => {
      expect(LOW_DISK_THRESHOLD_MB).toBe(2048);
    });
  });
});
