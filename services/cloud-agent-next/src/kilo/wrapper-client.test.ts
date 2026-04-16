/**
 * Unit tests for WrapperClient.
 *
 * Tests HTTP call formatting, error handling, and response parsing.
 * The WrapperClient uses session.exec to run curl inside the container.
 */

/* eslint-disable @typescript-eslint/unbound-method */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WrapperClient,
  WrapperError,
  WrapperNotReadyError,
  WrapperNoJobError,
  WrapperJobConflictError,
  type WrapperPromptOptions,
  type WrapperHealthResponse,
  type JobStatus,
} from './wrapper-client.js';
import type { ExecutionSession, SandboxInstance } from '../types.js';
import { WRAPPER_VERSION } from '../shared/wrapper-version.js';

vi.mock('./ports.js', () => ({
  randomPort: vi.fn(() => 10000 + Math.floor(Math.random() * 50000)),
  PORT_RANGE_MIN: 10000,
  PORT_RANGE_MAX: 60000,
}));

import { randomPort } from './ports.js';

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

type MockExecResult = {
  exitCode: number;
  stdout?: string;
  stderr?: string;
};

/** Pre-flight commands issued by ensureRunning before starting the wrapper */
const isPreflightCommand = (cmd: string) =>
  cmd.startsWith('bun --version') || cmd.startsWith('test -f ');

const preflightResult = (cmd: string): MockExecResult =>
  cmd.startsWith('bun --version')
    ? { exitCode: 0, stdout: '1.0.0' }
    : { exitCode: 0, stdout: 'ok' };

const createMockSession = (
  execResult: MockExecResult | ((cmd: string) => MockExecResult)
): ExecutionSession => {
  const execFn =
    typeof execResult === 'function'
      ? vi
          .fn()
          .mockImplementation((cmd: string) =>
            Promise.resolve(isPreflightCommand(cmd) ? preflightResult(cmd) : execResult(cmd))
          )
      : vi
          .fn()
          .mockImplementation((cmd: string) =>
            Promise.resolve(isPreflightCommand(cmd) ? preflightResult(cmd) : execResult)
          );

  // Mock startProcess that returns a process with waitForPort and getLogs
  const startProcessFn = vi.fn().mockImplementation(() =>
    Promise.resolve({
      id: 'mock-process-id',
      waitForPort: vi.fn().mockResolvedValue(undefined),
      getLogs: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    })
  );

  return {
    exec: execFn,
    writeFile: vi.fn(),
    deleteFile: vi.fn(),
    startProcess: startProcessFn,
  } as unknown as ExecutionSession;
};

const createSuccessResponse = <T>(data: T): MockExecResult => ({
  exitCode: 0,
  stdout: JSON.stringify(data),
});

const createErrorResponse = (error: string, message?: string): MockExecResult => ({
  exitCode: 0,
  stdout: JSON.stringify({ error, message: message ?? error }),
});

const createCurlError = (exitCode: number, stderr = ''): MockExecResult => ({
  exitCode,
  stderr,
});

const createMockSandbox = (
  existingWrapper: { port: number; healthy: boolean } | null = null
): SandboxInstance => {
  const processes = existingWrapper
    ? [
        {
          id: 'existing-wrapper-id',
          command: `WRAPPER_PORT=${existingWrapper.port} bun run /usr/local/bin/kilocode-wrapper.js --agent-session test-session`,
          status: 'running' as const,
        },
      ]
    : [];

  return {
    listProcesses: vi.fn().mockResolvedValue(processes),
  } as unknown as SandboxInstance;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WrapperClient', () => {
  const defaultPort = 5000;

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    it('creates client with session and port', () => {
      const session = createMockSession({ exitCode: 0, stdout: '{}' });
      const client = new WrapperClient({ session, port: defaultPort });

      expect(client).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Health Check
  // -------------------------------------------------------------------------

  describe('health', () => {
    it('returns health status on success', async () => {
      const healthResponse: WrapperHealthResponse = {
        healthy: true,
        state: 'idle',
        version: WRAPPER_VERSION,
        sessionId: 'kilo-sess-1',
      };

      const session = createMockSession(createSuccessResponse(healthResponse));
      const client = new WrapperClient({ session, port: defaultPort });

      const result = await client.health();

      expect(result).toEqual(healthResponse);
      expect(session.exec).toHaveBeenCalledWith(
        expect.stringContaining("curl -s -X GET -H 'Content-Type: application/json'")
      );
      expect(session.exec).toHaveBeenCalledWith(expect.stringContaining('/health'));
    });

    it('throws WrapperError on curl failure', async () => {
      const session = createMockSession(createCurlError(7, 'Connection refused'));
      const client = new WrapperClient({ session, port: defaultPort });

      await expect(client.health()).rejects.toThrow(WrapperError);
    });
  });

  // -------------------------------------------------------------------------
  // Job Status
  // -------------------------------------------------------------------------

  describe('status', () => {
    it('returns job status', async () => {
      const statusResponse: JobStatus = {
        state: 'active',
        executionId: 'exc_123',
        sessionId: 'kilo_456',
      };

      const session = createMockSession(createSuccessResponse(statusResponse));
      const client = new WrapperClient({ session, port: defaultPort });

      const result = await client.status();

      expect(result).toEqual(statusResponse);
      expect(session.exec).toHaveBeenCalledWith(expect.stringContaining('/job/status'));
    });

    it('returns idle status with lastError', async () => {
      const statusResponse: JobStatus = {
        state: 'idle',
        lastError: {
          code: 'INFLIGHT_TIMEOUT',
          messageId: 'exc_123',
          message: 'Timeout after 600s',
          timestamp: Date.now(),
        },
      };

      const session = createMockSession(createSuccessResponse(statusResponse));
      const client = new WrapperClient({ session, port: defaultPort });

      const result = await client.status();

      expect(result.lastError).toBeDefined();
      expect(result.lastError?.code).toBe('INFLIGHT_TIMEOUT');
    });
  });

  // -------------------------------------------------------------------------
  // (startJob removed — execution binding is now inline in prompt/command)
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Prompt
  // -------------------------------------------------------------------------

  describe('prompt', () => {
    it('returns messageId on success', async () => {
      const session = createMockSession(
        createSuccessResponse({ status: 'sent', messageId: 'msg_generated_1' })
      );
      const client = new WrapperClient({ session, port: defaultPort });

      const result = await client.prompt({ prompt: 'Hello, world!' });

      expect(result.messageId).toBe('msg_generated_1');
    });

    it('allows prompt responses without messageId', async () => {
      const session = createMockSession(createSuccessResponse({ status: 'sent' }));
      const client = new WrapperClient({ session, port: defaultPort });

      const result = await client.prompt({ prompt: 'Hello, world!' });

      expect(result.messageId).toBeUndefined();
    });

    it('sends prompt text', async () => {
      const session = createMockSession(
        createSuccessResponse({ status: 'sent', messageId: 'msg_1' })
      );
      const client = new WrapperClient({ session, port: defaultPort });

      await client.prompt({ prompt: 'Test prompt' });

      const execCall = (session.exec as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(execCall).toContain('/job/prompt');
      expect(execCall).toContain('Test prompt');
    });

    it('sends all options', async () => {
      const session = createMockSession(
        createSuccessResponse({ status: 'sent', messageId: 'msg_custom' })
      );
      const client = new WrapperClient({ session, port: defaultPort });

      const options: WrapperPromptOptions = {
        prompt: 'Complex prompt',
        model: { providerID: 'kilo', modelID: 'anthropic/claude-sonnet-4-20250514' },
        agent: 'code',
        messageId: 'msg_custom',
        system: 'You are a helpful assistant',
        tools: { read_file: true, write_file: false },
      };

      await client.prompt(options);

      const execCall = (session.exec as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(execCall).toContain('/job/prompt');
    });

    it('includes variant in request body when provided', async () => {
      const session = createMockSession(
        createSuccessResponse({ status: 'sent', messageId: 'msg_variant' })
      );
      const client = new WrapperClient({ session, port: defaultPort });

      await client.prompt({
        prompt: 'Test with variant',
        variant: 'high',
      });

      const execCall = (session.exec as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(execCall).toContain('"variant":"high"');
    });

    it('preserves file parts in request body', async () => {
      const session = createMockSession(
        createSuccessResponse({ status: 'sent', messageId: 'msg_files' })
      );
      const client = new WrapperClient({ session, port: defaultPort });

      await client.prompt({
        parts: [
          { type: 'text', text: 'Describe these images' },
          {
            type: 'file',
            mime: 'image/png',
            url: 'file:///tmp/first.png',
            filename: 'first.png',
          },
          {
            type: 'file',
            mime: 'image/jpeg',
            url: 'file:///tmp/second.jpg',
            filename: 'second.jpg',
          },
        ],
      });

      const execCall = (session.exec as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(execCall).toContain(
        '"parts":[{"type":"text","text":"Describe these images"},{"type":"file","mime":"image/png","url":"file:///tmp/first.png","filename":"first.png"},{"type":"file","mime":"image/jpeg","url":"file:///tmp/second.jpg","filename":"second.jpg"}]'
      );
    });

    it('throws WrapperNoJobError when no job started', async () => {
      const session = createMockSession(createErrorResponse('NO_JOB', 'Call /job/start first'));
      const client = new WrapperClient({ session, port: defaultPort });

      await expect(client.prompt({ prompt: 'test' })).rejects.toThrow(WrapperNoJobError);
    });
  });

  // -------------------------------------------------------------------------
  // Command
  // -------------------------------------------------------------------------

  describe('command', () => {
    it('returns command result', async () => {
      const commandResult = { messages: ['Cleared 5 messages'] };
      const session = createMockSession(
        createSuccessResponse({ status: 'sent', result: commandResult })
      );
      const client = new WrapperClient({ session, port: defaultPort });

      const result = await client.command({ command: 'clear' });

      expect(result).toEqual(commandResult);
    });

    it('sends command and args', async () => {
      const session = createMockSession(createSuccessResponse({ status: 'sent', result: {} }));
      const client = new WrapperClient({ session, port: defaultPort });

      await client.command({ command: 'compact', args: '--aggressive' });

      const execCall = (session.exec as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(execCall).toContain('/job/command');
      expect(execCall).toContain('compact');
      expect(execCall).toContain('--aggressive');
    });
  });

  // -------------------------------------------------------------------------
  // Answer Permission
  // -------------------------------------------------------------------------

  describe('answerPermission', () => {
    it('returns success on valid response', async () => {
      const session = createMockSession(
        createSuccessResponse({ status: 'answered', success: true })
      );
      const client = new WrapperClient({ session, port: defaultPort });

      const result = await client.answerPermission('perm_123', 'once');

      expect(result.success).toBe(true);
    });

    it('sends permission response', async () => {
      const session = createMockSession(
        createSuccessResponse({ status: 'answered', success: true })
      );
      const client = new WrapperClient({ session, port: defaultPort });

      await client.answerPermission('perm_456', 'always');

      const execCall = (session.exec as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(execCall).toContain('/job/answer-permission');
      expect(execCall).toContain('perm_456');
      expect(execCall).toContain('always');
    });

    it('handles reject response', async () => {
      const session = createMockSession(
        createSuccessResponse({ status: 'answered', success: true })
      );
      const client = new WrapperClient({ session, port: defaultPort });

      await client.answerPermission('perm_789', 'reject');

      const execCall = (session.exec as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(execCall).toContain('reject');
    });
  });

  // -------------------------------------------------------------------------
  // Answer Question
  // -------------------------------------------------------------------------

  describe('answerQuestion', () => {
    it('returns success', async () => {
      const session = createMockSession(
        createSuccessResponse({ status: 'answered', success: true })
      );
      const client = new WrapperClient({ session, port: defaultPort });

      const result = await client.answerQuestion('q_123', [['Yes']]);

      expect(result.success).toBe(true);
    });

    it('sends answers array', async () => {
      const session = createMockSession(
        createSuccessResponse({ status: 'answered', success: true })
      );
      const client = new WrapperClient({ session, port: defaultPort });

      await client.answerQuestion('q_456', [['Option A', 'Option B']]);

      const execCall = (session.exec as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(execCall).toContain('/job/answer-question');
      expect(execCall).toContain('q_456');
    });
  });

  // -------------------------------------------------------------------------
  // Reject Question
  // -------------------------------------------------------------------------

  describe('rejectQuestion', () => {
    it('returns success', async () => {
      const session = createMockSession(
        createSuccessResponse({ status: 'rejected', success: true })
      );
      const client = new WrapperClient({ session, port: defaultPort });

      const result = await client.rejectQuestion('q_789');

      expect(result.success).toBe(true);
    });

    it('calls correct endpoint', async () => {
      const session = createMockSession(
        createSuccessResponse({ status: 'rejected', success: true })
      );
      const client = new WrapperClient({ session, port: defaultPort });

      await client.rejectQuestion('q_abc');

      const execCall = (session.exec as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(execCall).toContain('/job/reject-question');
      expect(execCall).toContain('q_abc');
    });
  });

  // -------------------------------------------------------------------------
  // Abort
  // -------------------------------------------------------------------------

  describe('abort', () => {
    it('completes without error', async () => {
      const session = createMockSession(createSuccessResponse({ status: 'aborted' }));
      const client = new WrapperClient({ session, port: defaultPort });

      await expect(client.abort()).resolves.not.toThrow();
    });

    it('calls abort endpoint', async () => {
      const session = createMockSession(createSuccessResponse({ status: 'aborted' }));
      const client = new WrapperClient({ session, port: defaultPort });

      await client.abort();

      const execCall = (session.exec as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(execCall).toContain('/job/abort');
    });
  });

  // -------------------------------------------------------------------------
  // Ensure Running
  // -------------------------------------------------------------------------

  describe('ensureRunning', () => {
    const agentSessionId = 'test-session';
    const userId = 'test-user';

    it('returns immediately if wrapper already healthy', async () => {
      const healthResponse: WrapperHealthResponse = {
        healthy: true,
        state: 'idle',
        version: WRAPPER_VERSION,
        sessionId: 'kilo-sess-1',
      };

      const session = createMockSession(createSuccessResponse(healthResponse));
      const client = new WrapperClient({ session, port: defaultPort });

      await client.ensureRunning({
        agentSessionId,
        userId,
        workspacePath: '/workspace/test',
      });

      // Should only call health once (already running)
      expect(session.exec).toHaveBeenCalledTimes(1);
    });

    it('starts wrapper and waits for port via startProcess', async () => {
      // Health check fails (not running)
      const session = createMockSession(createCurlError(7, 'Connection refused'));

      // Track that waitForPort was called
      const waitForPortMock = vi.fn().mockResolvedValue(undefined);
      (session.startProcess as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'mock-process-id',
        waitForPort: waitForPortMock,
        getLogs: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      });

      const client = new WrapperClient({ session, port: defaultPort });

      await client.ensureRunning({
        agentSessionId,
        userId,
        maxWaitMs: 5000,
        workspacePath: '/workspace/test',
      });

      // Should have called startProcess and waitForPort
      expect(session.startProcess).toHaveBeenCalledTimes(1);
      expect(waitForPortMock).toHaveBeenCalledWith(defaultPort, {
        mode: 'http',
        path: '/health',
        timeout: 5000,
      });
    });

    it('throws WrapperNotReadyError after exhausting all retry attempts', async () => {
      // Health check fails (not running)
      const session = createMockSession(createCurlError(7, 'Connection refused'));

      const getLogsMock = vi
        .fn()
        .mockResolvedValue({ stdout: 'some output', stderr: 'some error' });
      // Make startProcess return a process where waitForPort times out
      (session.startProcess as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'mock-process-id',
        waitForPort: vi.fn().mockRejectedValue(new Error('Port not ready within timeout')),
        getLogs: getLogsMock,
      });

      const client = new WrapperClient({ session, port: defaultPort });

      await expect(
        client.ensureRunning({
          agentSessionId,
          userId,
          maxWaitMs: 100,
          workspacePath: '/workspace/test',
        })
      ).rejects.toThrow(WrapperNotReadyError);

      // ensureRunning makes ONE attempt (port retry lives in ensureWrapper)
      expect(session.startProcess).toHaveBeenCalledTimes(1);
      // getLogs should be called on the single failed attempt
      expect(getLogsMock).toHaveBeenCalledTimes(1);
      // pkill should be called to clean up the failed process
      const execCalls = (session.exec as ReturnType<typeof vi.fn>).mock.calls;
      const pkillCalls = execCalls.filter(call => String(call[0]).includes('pkill'));
      expect(pkillCalls).toHaveLength(1);
      expect(pkillCalls[0][0]).toContain('--agent-session test-session');
    });

    it('throws on failure without retrying (retry lives in ensureWrapper)', async () => {
      const session = createMockSession(createCurlError(7, 'Connection refused'));

      (session.startProcess as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'mock-process-1',
        waitForPort: vi.fn().mockRejectedValue(new Error('SIGILL')),
        getLogs: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      });

      const client = new WrapperClient({ session, port: defaultPort });

      await expect(
        client.ensureRunning({
          agentSessionId,
          userId,
          maxWaitMs: 5000,
          workspacePath: '/workspace/test',
        })
      ).rejects.toThrow(WrapperNotReadyError);

      // ensureRunning makes ONE attempt — no internal retry
      expect(session.startProcess).toHaveBeenCalledTimes(1);
    });

    it('calls getLogs on process when startup fails', async () => {
      const session = createMockSession(createCurlError(7, 'Connection refused'));

      const getLogsMock = vi.fn().mockResolvedValue({
        stdout: 'wrapper output before crash',
        stderr: 'illegal instruction',
      });

      (session.startProcess as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'mock-process-id',
        waitForPort: vi.fn().mockRejectedValue(new Error('Process exited with code 132')),
        getLogs: getLogsMock,
      });

      const client = new WrapperClient({ session, port: defaultPort });

      await expect(
        client.ensureRunning({
          agentSessionId,
          userId,
          maxWaitMs: 100,
          workspacePath: '/workspace/test',
        })
      ).rejects.toThrow(WrapperNotReadyError);

      // getLogs should be called on the single failed attempt
      expect(getLogsMock).toHaveBeenCalledTimes(1);
    });

    it('uses default wrapper path and calls startProcess', async () => {
      // Health check fails first (not running), then we start
      let healthCheckCount = 0;
      const session = createMockSession((cmd: string) => {
        if (cmd.includes('/health')) {
          healthCheckCount++;
          if (healthCheckCount === 1) {
            return createCurlError(7); // First check: not running
          }
        }
        return createSuccessResponse({
          healthy: true,
          state: 'idle',
          version: WRAPPER_VERSION,
          sessionId: 'kilo-sess-1',
        });
      });

      const client = new WrapperClient({ session, port: defaultPort });

      await client.ensureRunning({
        agentSessionId,
        userId,
        maxWaitMs: 1000,
        workspacePath: '/workspace/test',
      });

      // Verify startProcess was called with the wrapper command
      expect(session.startProcess).toHaveBeenCalledTimes(1);
      const startProcessCall = (session.startProcess as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(startProcessCall[0]).toContain('kilocode-wrapper');
      expect(startProcessCall[0]).toContain('WRAPPER_PORT=5000');
      expect(startProcessCall[0]).not.toContain('KILO_SERVER_PORT');
      expect(startProcessCall[0]).toContain('--agent-session test-session');
      expect(startProcessCall[0]).toContain("--user-id 'test-user'");
    });

    it('includes --session-id when provided', async () => {
      const session = createMockSession(createCurlError(7, 'Connection refused'));
      (session.startProcess as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'mock-process-id',
        waitForPort: vi.fn().mockResolvedValue(undefined),
        getLogs: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      });

      const client = new WrapperClient({ session, port: defaultPort });

      await client.ensureRunning({
        agentSessionId,
        userId,
        workspacePath: '/workspace/test',
        sessionId: 'kilo-sess-existing',
      });

      const startProcessCall = (session.startProcess as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(startProcessCall[0]).toContain("--session-id 'kilo-sess-existing'");
    });

    it('omits --session-id when not provided', async () => {
      const session = createMockSession(createCurlError(7, 'Connection refused'));
      (session.startProcess as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'mock-process-id',
        waitForPort: vi.fn().mockResolvedValue(undefined),
        getLogs: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      });

      const client = new WrapperClient({ session, port: defaultPort });

      await client.ensureRunning({
        agentSessionId,
        userId,
        workspacePath: '/workspace/test',
      });

      const startProcessCall = (session.startProcess as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(startProcessCall[0]).not.toContain('--session-id');
      // Core env vars still present
      expect(startProcessCall[0]).toContain('WRAPPER_PORT=5000');
      expect(startProcessCall[0]).toContain('WORKSPACE_PATH=/workspace/test');
      expect(startProcessCall[0]).toContain("--user-id 'test-user'");
    });
  });

  // -------------------------------------------------------------------------
  // Pre-flight checks
  // -------------------------------------------------------------------------

  describe('pre-flight checks', () => {
    it('throws WrapperNotReadyError when bun exits with SIGILL (exit code 132)', async () => {
      const session = createMockSession(createCurlError(7, 'Connection refused'));
      // Override exec to simulate SIGILL on bun --version
      (session.exec as ReturnType<typeof vi.fn>).mockImplementation((cmd: string) => {
        if (cmd.startsWith('bun --version')) {
          return Promise.resolve({ exitCode: 132, stderr: '' });
        }
        if (cmd.startsWith('test -f')) {
          return Promise.resolve({ exitCode: 0, stdout: 'ok' });
        }
        return Promise.resolve(createCurlError(7, 'Connection refused'));
      });

      const client = new WrapperClient({ session, port: defaultPort });

      await expect(
        client.ensureRunning({
          agentSessionId: 'test-session',
          userId: 'test-user',
          workspacePath: '/workspace/test',
        })
      ).rejects.toThrow(/SIGILL/);
    });

    it('throws WrapperNotReadyError when bun exits with non-zero code', async () => {
      const session = createMockSession(createCurlError(7, 'Connection refused'));
      (session.exec as ReturnType<typeof vi.fn>).mockImplementation((cmd: string) => {
        if (cmd.startsWith('bun --version')) {
          return Promise.resolve({ exitCode: 127, stderr: 'bun: not found' });
        }
        if (cmd.startsWith('test -f')) {
          return Promise.resolve({ exitCode: 0, stdout: 'ok' });
        }
        return Promise.resolve(createCurlError(7, 'Connection refused'));
      });

      const client = new WrapperClient({ session, port: defaultPort });

      await expect(
        client.ensureRunning({
          agentSessionId: 'test-session',
          userId: 'test-user',
          workspacePath: '/workspace/test',
        })
      ).rejects.toThrow(/bun runtime is broken.*exit code 127/);
    });

    it('throws WrapperNotReadyError when wrapper binary is missing', async () => {
      const session = createMockSession(createCurlError(7, 'Connection refused'));
      (session.exec as ReturnType<typeof vi.fn>).mockImplementation((cmd: string) => {
        if (cmd.startsWith('bun --version')) {
          return Promise.resolve({ exitCode: 0, stdout: '1.0.0' });
        }
        if (cmd.startsWith('test -f')) {
          return Promise.resolve({ exitCode: 1, stdout: '' });
        }
        return Promise.resolve(createCurlError(7, 'Connection refused'));
      });

      const client = new WrapperClient({ session, port: defaultPort });

      await expect(
        client.ensureRunning({
          agentSessionId: 'test-session',
          userId: 'test-user',
          workspacePath: '/workspace/test',
        })
      ).rejects.toThrow(/not found in container/);
    });

    it('proceeds when pre-flight exec itself fails (e.g. sandbox timeout)', async () => {
      const session = createMockSession(createCurlError(7, 'Connection refused'));
      (session.exec as ReturnType<typeof vi.fn>).mockImplementation((cmd: string) => {
        if (cmd.startsWith('bun --version') || cmd.startsWith('test -f')) {
          return Promise.reject(new Error('sandbox timeout'));
        }
        return Promise.resolve(createCurlError(7, 'Connection refused'));
      });
      (session.startProcess as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'mock-process-id',
        waitForPort: vi.fn().mockResolvedValue(undefined),
        getLogs: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      });

      const client = new WrapperClient({ session, port: defaultPort });

      // Should not throw; pre-flight failure is non-blocking
      await client.ensureRunning({
        agentSessionId: 'test-session',
        userId: 'test-user',
        workspacePath: '/workspace/test',
      });

      expect(session.startProcess).toHaveBeenCalledTimes(1);
    });

    it('surfaces fatal bun SIGILL even when the file check rejects', async () => {
      const session = createMockSession(createCurlError(7, 'Connection refused'));
      (session.exec as ReturnType<typeof vi.fn>).mockImplementation((cmd: string) => {
        if (cmd.startsWith('bun --version')) {
          return Promise.resolve({ exitCode: 132, stderr: '' });
        }
        if (cmd.startsWith('test -f')) {
          return Promise.reject(new Error('sandbox timeout'));
        }
        return Promise.resolve(createCurlError(7, 'Connection refused'));
      });

      const client = new WrapperClient({ session, port: defaultPort });

      await expect(
        client.ensureRunning({
          agentSessionId: 'test-session',
          userId: 'test-user',
          workspacePath: '/workspace/test',
        })
      ).rejects.toThrow(/SIGILL/);
    });

    it('surfaces missing wrapper even when the bun check rejects', async () => {
      const session = createMockSession(createCurlError(7, 'Connection refused'));
      (session.exec as ReturnType<typeof vi.fn>).mockImplementation((cmd: string) => {
        if (cmd.startsWith('bun --version')) {
          return Promise.reject(new Error('sandbox timeout'));
        }
        if (cmd.startsWith('test -f')) {
          return Promise.resolve({ exitCode: 1, stdout: '' });
        }
        return Promise.resolve(createCurlError(7, 'Connection refused'));
      });

      const client = new WrapperClient({ session, port: defaultPort });

      await expect(
        client.ensureRunning({
          agentSessionId: 'test-session',
          userId: 'test-user',
          workspacePath: '/workspace/test',
        })
      ).rejects.toThrow(/not found in container/);
    });

    it('shell-quotes wrapperPath in the pre-flight file check', async () => {
      const session = createMockSession(createCurlError(7, 'Connection refused'));
      (session.exec as ReturnType<typeof vi.fn>).mockImplementation((cmd: string) => {
        if (cmd.startsWith('bun --version')) {
          return Promise.resolve({ exitCode: 0, stdout: '1.0.0' });
        }
        if (cmd.startsWith('test -f')) {
          return Promise.resolve({ exitCode: 0, stdout: '' });
        }
        return Promise.resolve(createCurlError(7, 'Connection refused'));
      });
      (session.startProcess as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'mock-process-id',
        waitForPort: vi.fn().mockResolvedValue(undefined),
        getLogs: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      });

      const client = new WrapperClient({ session, port: defaultPort });

      await client.ensureRunning({
        agentSessionId: 'test-session',
        userId: 'test-user',
        workspacePath: '/workspace/test',
        wrapperPath: "./wrapper's folder/wrapper.js; touch /tmp/pwned",
      });

      expect(session.exec).toHaveBeenCalledWith(
        "test -f './wrapper'\\''s folder/wrapper.js; touch /tmp/pwned'",
        expect.objectContaining({ cwd: '/workspace/test', timeout: 5_000 })
      );
    });

    it('shell-quotes wrapperPath in the startup command', async () => {
      const session = createMockSession(createCurlError(7, 'Connection refused'));
      (session.startProcess as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'mock-process-id',
        waitForPort: vi.fn().mockResolvedValue(undefined),
        getLogs: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      });

      const client = new WrapperClient({ session, port: defaultPort });

      await client.ensureRunning({
        agentSessionId: 'test-session',
        userId: 'test-user',
        workspacePath: '/workspace/test',
        wrapperPath: "./wrapper's folder/wrapper.js; touch /tmp/pwned",
      });

      expect(session.startProcess).toHaveBeenCalledWith(
        expect.stringMatching(
          /^WRAPPER_PORT=5000 WORKSPACE_PATH=\/workspace\/test WRAPPER_LOG_PATH=\/tmp\/kilocode-wrapper-test-session-\d+\.log KILO_SESSION_RETRY_LIMIT=5 KILO_CLOUD_AGENT=1 bun run '\.\/wrapper'\\''s folder\/wrapper\.js; touch \/tmp\/pwned' --agent-session test-session --user-id 'test-user'$/
        ),
        expect.objectContaining({ cwd: '/workspace' })
      );
    });
  });

  // -------------------------------------------------------------------------
  // Ensure Wrapper (static method)
  // -------------------------------------------------------------------------

  describe('ensureWrapper', () => {
    const wrapperOptions = {
      agentSessionId: 'test-session',
      userId: 'test-user',
      workspacePath: '/workspace/test',
    };

    const healthResponseData = {
      healthy: true,
      state: 'idle',
      version: WRAPPER_VERSION,
      sessionId: 'kilo-sess-1',
    };

    beforeEach(() => {
      vi.mocked(randomPort).mockReset();
      vi.mocked(randomPort).mockImplementation(() => 10000 + Math.floor(Math.random() * 50000));
    });

    it('reuses existing healthy wrapper', async () => {
      const session = createMockSession(createSuccessResponse(healthResponseData));
      const sandbox = createMockSandbox({ port: 5555, healthy: true });

      const { client, sessionId } = await WrapperClient.ensureWrapper(
        sandbox,
        session,
        wrapperOptions
      );

      expect(client).toBeDefined();
      expect(sessionId).toBe('kilo-sess-1');
      // Should have called listProcesses to find existing wrapper
      expect(sandbox.listProcesses).toHaveBeenCalledTimes(1);
      // Should NOT have started a new process
      expect(session.startProcess).not.toHaveBeenCalled();
    });

    it('starts new wrapper when none exists', async () => {
      // Health check during ensureRunning fails, but health after startup succeeds
      let healthCalls = 0;
      const session = createMockSession((cmd: string) => {
        if (cmd.includes('/health')) {
          healthCalls++;
          // First call fails (ensureRunning check), second succeeds (post-startup health)
          if (healthCalls <= 1) return createCurlError(7, 'Connection refused');
          return createSuccessResponse(healthResponseData);
        }
        return createCurlError(7, 'Connection refused');
      });
      (session.startProcess as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'new-wrapper-id',
        waitForPort: vi.fn().mockResolvedValue(undefined),
        getLogs: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      });
      const sandbox = createMockSandbox(null);

      const { client, sessionId } = await WrapperClient.ensureWrapper(
        sandbox,
        session,
        wrapperOptions
      );

      expect(client).toBeDefined();
      expect(sessionId).toBe('kilo-sess-1');
      expect(session.startProcess).toHaveBeenCalled();
    });

    it('retries with new port on EADDRINUSE', async () => {
      let healthCalls = 0;
      const session = createMockSession((cmd: string) => {
        if (cmd.includes('/health')) {
          healthCalls++;
          // Health checks during ensureRunning always fail, but after successful startup they pass
          if (healthCalls <= 3) return createCurlError(7, 'Connection refused');
          return createSuccessResponse(healthResponseData);
        }
        return createCurlError(7, 'Connection refused');
      });

      let startAttempt = 0;
      (session.startProcess as ReturnType<typeof vi.fn>).mockImplementation(() => {
        startAttempt++;
        if (startAttempt <= 2) {
          return Promise.resolve({
            id: `proc-${startAttempt}`,
            waitForPort: vi.fn().mockRejectedValue(new Error('Port not ready within timeout')),
            getLogs: vi.fn().mockResolvedValue({
              stdout: '',
              stderr: 'Error: EADDRINUSE: address already in use',
            }),
          });
        }
        return Promise.resolve({
          id: `proc-${startAttempt}`,
          waitForPort: vi.fn().mockResolvedValue(undefined),
          getLogs: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
        });
      });

      const mockedRandomPort = vi.mocked(randomPort);
      mockedRandomPort
        .mockReturnValueOnce(30000)
        .mockReturnValueOnce(30001)
        .mockReturnValueOnce(30002);

      const sandbox = createMockSandbox(null);

      const { client } = await WrapperClient.ensureWrapper(sandbox, session, wrapperOptions);

      expect(client).toBeDefined();
      expect((session.startProcess as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
    });

    it('retries all errors with new ports (no distinction between error types)', async () => {
      const session = createMockSession(createCurlError(7, 'Connection refused'));
      (session.startProcess as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'proc-1',
        waitForPort: vi.fn().mockRejectedValue(new Error('Process exited with code 132')),
        getLogs: vi.fn().mockResolvedValue({ stdout: '', stderr: 'illegal instruction' }),
      });

      const sandbox = createMockSandbox(null);

      await expect(WrapperClient.ensureWrapper(sandbox, session, wrapperOptions)).rejects.toThrow();

      // ensureWrapper retries ALL errors with a new port (MAX_PORT_ATTEMPTS = 3)
      expect(vi.mocked(randomPort)).toHaveBeenCalledTimes(3);
    });

    it('throws after exhausting all port attempts on EADDRINUSE', async () => {
      const session = createMockSession(createCurlError(7, 'Connection refused'));
      (session.startProcess as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'proc',
        waitForPort: vi.fn().mockRejectedValue(new Error('Port not ready within timeout')),
        getLogs: vi
          .fn()
          .mockResolvedValue({ stdout: '', stderr: 'Error: EADDRINUSE: address already in use' }),
      });

      const sandbox = createMockSandbox(null);

      await expect(WrapperClient.ensureWrapper(sandbox, session, wrapperOptions)).rejects.toThrow(
        WrapperNotReadyError
      );
    }, 30_000);

    it('starts new wrapper when existing wrapper is unhealthy', async () => {
      // Health call sequence:
      // 1. existing wrapper health check -> fail (unhealthy)
      // 2. ensureRunning initial health check -> fail (not running yet)
      // 3. post-startup health check (ensureWrapper reads sessionId) -> succeed
      let healthCalls = 0;
      const session = createMockSession((cmd: string) => {
        if (cmd.includes('/health')) {
          healthCalls++;
          if (healthCalls <= 2) {
            return createCurlError(7, 'Connection refused');
          }
          return createSuccessResponse(healthResponseData);
        }
        return createCurlError(7, 'Connection refused');
      });
      (session.startProcess as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'new-wrapper-id',
        waitForPort: vi.fn().mockResolvedValue(undefined),
        getLogs: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      });

      const sandbox = createMockSandbox({ port: 5555, healthy: false });

      const { client } = await WrapperClient.ensureWrapper(sandbox, session, wrapperOptions);

      expect(client).toBeDefined();
      expect(session.startProcess).toHaveBeenCalled();
    });

    it('passes sessionId to ensureRunning', async () => {
      let healthCalls = 0;
      const session = createMockSession((cmd: string) => {
        if (cmd.includes('/health')) {
          healthCalls++;
          if (healthCalls <= 1) return createCurlError(7, 'Connection refused');
          return createSuccessResponse(healthResponseData);
        }
        return createCurlError(7, 'Connection refused');
      });
      (session.startProcess as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'new-wrapper-id',
        waitForPort: vi.fn().mockResolvedValue(undefined),
        getLogs: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      });
      const sandbox = createMockSandbox(null);

      await WrapperClient.ensureWrapper(sandbox, session, {
        ...wrapperOptions,
        sessionId: 'expected-kilo-sess',
      });

      const startProcessCall = (session.startProcess as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(startProcessCall[0]).toContain("--session-id 'expected-kilo-sess'");
    });
  });

  // -------------------------------------------------------------------------
  // Error Handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('parses JSON error response', async () => {
      const session = createMockSession(
        createErrorResponse('CUSTOM_ERROR', 'Custom error message')
      );
      const client = new WrapperClient({ session, port: defaultPort });

      try {
        await client.health();
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(WrapperError);
        expect((error as WrapperError).message).toContain('Custom error message');
      }
    });

    it('handles empty response body', async () => {
      const session = createMockSession({ exitCode: 0, stdout: '' });
      const client = new WrapperClient({ session, port: defaultPort });

      // Empty response should return empty object
      const result = await client.health();
      expect(result).toEqual({});
    });

    it('handles malformed JSON response', async () => {
      const session = createMockSession({ exitCode: 0, stdout: 'not json' });
      const client = new WrapperClient({ session, port: defaultPort });

      await expect(client.health()).rejects.toThrow(WrapperError);
    });

    it('handles curl exit codes', async () => {
      const session = createMockSession(createCurlError(28, 'Operation timed out'));
      const client = new WrapperClient({ session, port: defaultPort });

      try {
        await client.health();
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(WrapperError);
        expect((error as WrapperError).code).toBe('REQUEST_FAILED');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Request Formatting
  // -------------------------------------------------------------------------

  describe('request formatting', () => {
    it('escapes single quotes in JSON body', async () => {
      const session = createMockSession(
        createSuccessResponse({ status: 'sent', messageId: 'msg_1' })
      );
      const client = new WrapperClient({ session, port: defaultPort });

      await client.prompt({ prompt: "It's a test with 'quotes'" });

      const execCall = (session.exec as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      // Single quotes should be escaped for shell
      expect(execCall).toContain("'\\''");
    });

    it('uses correct HTTP method for GET requests', async () => {
      const session = createMockSession(
        createSuccessResponse({ healthy: true, state: 'idle', version: '1.0.0' })
      );
      const client = new WrapperClient({ session, port: defaultPort });

      await client.health();

      const execCall = (session.exec as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(execCall).toContain('-X GET');
    });

    it('uses correct HTTP method for POST requests', async () => {
      const session = createMockSession(
        createSuccessResponse({ status: 'sent', messageId: 'msg_1' })
      );
      const client = new WrapperClient({ session, port: defaultPort });

      await client.prompt({ prompt: 'test' });

      const execCall = (session.exec as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(execCall).toContain('-X POST');
    });

    it('constructs correct URL with port', async () => {
      const customPort = 5123;
      const session = createMockSession(
        createSuccessResponse({ healthy: true, state: 'idle', version: '1.0.0' })
      );
      const client = new WrapperClient({ session, port: customPort });

      await client.health();

      const execCall = (session.exec as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(execCall).toContain(`http://127.0.0.1:${customPort}`);
    });
  });

  // -------------------------------------------------------------------------
  // Error Classes
  // -------------------------------------------------------------------------

  describe('error classes', () => {
    it('WrapperError has correct properties', () => {
      const error = new WrapperError('Test message', 'TEST_CODE', 500);

      expect(error.message).toBe('Test message');
      expect(error.code).toBe('TEST_CODE');
      expect(error.statusCode).toBe(500);
      expect(error.name).toBe('WrapperError');
    });

    it('WrapperNotReadyError has correct properties', () => {
      const error = new WrapperNotReadyError('Not ready');

      expect(error.code).toBe('NOT_READY');
      expect(error.statusCode).toBe(503);
      expect(error.name).toBe('WrapperNotReadyError');
    });

    it('WrapperNoJobError has correct properties', () => {
      const error = new WrapperNoJobError('No job');

      expect(error.code).toBe('NO_JOB');
      expect(error.statusCode).toBe(400);
      expect(error.name).toBe('WrapperNoJobError');
    });

    it('WrapperJobConflictError has correct properties', () => {
      const error = new WrapperJobConflictError('Conflict');

      expect(error.code).toBe('JOB_CONFLICT');
      expect(error.statusCode).toBe(409);
      expect(error.name).toBe('WrapperJobConflictError');
    });

    it('error classes extend WrapperError', () => {
      expect(new WrapperNotReadyError('test')).toBeInstanceOf(WrapperError);
      expect(new WrapperNoJobError('test')).toBeInstanceOf(WrapperError);
      expect(new WrapperJobConflictError('test')).toBeInstanceOf(WrapperError);
    });
  });
});
