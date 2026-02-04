/**
 * Unit tests for WrapperClient.
 *
 * Tests HTTP call formatting, error handling, and response parsing.
 * The WrapperClient uses session.exec to run curl inside the container.
 */

/* eslint-disable @typescript-eslint/unbound-method */

import { describe, expect, it, vi } from 'vitest';
import {
  WrapperClient,
  WrapperError,
  WrapperNotReadyError,
  WrapperNoJobError,
  WrapperJobConflictError,
  type StartJobOptions,
  type WrapperPromptOptions,
  type WrapperHealthResponse,
  type JobStatus,
} from './wrapper-client.js';
import type { ExecutionSession } from '../types.js';

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

type MockExecResult = {
  exitCode: number;
  stdout?: string;
  stderr?: string;
};

const createMockSession = (
  execResult: MockExecResult | ((cmd: string) => MockExecResult)
): ExecutionSession => {
  const execFn =
    typeof execResult === 'function'
      ? vi.fn().mockImplementation((cmd: string) => Promise.resolve(execResult(cmd)))
      : vi.fn().mockResolvedValue(execResult);

  // Mock startProcess that returns a process with waitForPort
  const startProcessFn = vi.fn().mockImplementation(() =>
    Promise.resolve({
      id: 'mock-process-id',
      waitForPort: vi.fn().mockResolvedValue(undefined),
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
        inflightCount: 0,
        version: '1.0.0',
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
        executionId: 'exec_123',
        kiloSessionId: 'kilo_456',
        inflight: ['msg_1', 'msg_2'],
        inflightCount: 2,
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
        inflight: [],
        inflightCount: 0,
        lastError: {
          code: 'INFLIGHT_TIMEOUT',
          messageId: 'msg_123',
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
  // Start Job
  // -------------------------------------------------------------------------

  describe('startJob', () => {
    const startJobOptions: StartJobOptions = {
      executionId: 'exec_123',
      ingestUrl: 'wss://ingest.example.com',
      ingestToken: 'token_secret',
      sessionId: 'session_abc',
      userId: 'user_xyz',
      kilocodeToken: 'kilo_token',
    };

    it('returns kiloSessionId on success', async () => {
      const session = createMockSession(
        createSuccessResponse({ status: 'started', kiloSessionId: 'kilo_sess_new' })
      );
      const client = new WrapperClient({ session, port: defaultPort });

      const result = await client.startJob(startJobOptions);

      expect(result.kiloSessionId).toBe('kilo_sess_new');
    });

    it('sends all options in request body', async () => {
      const session = createMockSession(
        createSuccessResponse({ status: 'started', kiloSessionId: 'kilo_sess_new' })
      );
      const client = new WrapperClient({ session, port: defaultPort });

      await client.startJob({
        ...startJobOptions,
        kiloSessionId: 'existing_kilo_sess',
        kiloSessionTitle: 'My Session',
      });

      const execCall = (session.exec as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(execCall).toContain('/job/start');
      expect(execCall).toContain('-d');
      // Body should contain the JSON data
      expect(execCall).toContain('executionId');
    });

    it('throws WrapperJobConflictError on conflict', async () => {
      const session = createMockSession(createErrorResponse('JOB_CONFLICT', 'Job already running'));
      const client = new WrapperClient({ session, port: defaultPort });

      await expect(client.startJob(startJobOptions)).rejects.toThrow(WrapperJobConflictError);
    });
  });

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
        agent: 'build',
        messageId: 'msg_custom',
        system: 'You are a helpful assistant',
        tools: { read_file: true, write_file: false },
      };

      await client.prompt(options);

      const execCall = (session.exec as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(execCall).toContain('/job/prompt');
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

      const result = await client.command('clear');

      expect(result).toEqual(commandResult);
    });

    it('sends command and args', async () => {
      const session = createMockSession(createSuccessResponse({ status: 'sent', result: {} }));
      const client = new WrapperClient({ session, port: defaultPort });

      await client.command('compact', '--aggressive');

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

      const result = await client.answerQuestion('q_123', ['Yes']);

      expect(result.success).toBe(true);
    });

    it('sends answers array', async () => {
      const session = createMockSession(
        createSuccessResponse({ status: 'answered', success: true })
      );
      const client = new WrapperClient({ session, port: defaultPort });

      await client.answerQuestion('q_456', ['Option A', 'Option B']);

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
    it('returns immediately if wrapper already healthy', async () => {
      const healthResponse: WrapperHealthResponse = {
        healthy: true,
        state: 'idle',
        inflightCount: 0,
        version: '1.0.0',
      };

      const session = createMockSession(createSuccessResponse(healthResponse));
      const client = new WrapperClient({ session, port: defaultPort });

      await client.ensureRunning({
        sessionId: 'test-session',
        kiloServerPort: 4600,
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
      });

      const client = new WrapperClient({ session, port: defaultPort });

      await client.ensureRunning({
        sessionId: 'test-session',
        pollIntervalMs: 10,
        maxWaitMs: 5000,
        kiloServerPort: 4600,
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

    it('throws WrapperNotReadyError on timeout', async () => {
      // Health check fails (not running)
      const session = createMockSession(createCurlError(7, 'Connection refused'));

      // Make startProcess return a process where waitForPort times out
      (session.startProcess as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'mock-process-id',
        waitForPort: vi.fn().mockRejectedValue(new Error('Port not ready within timeout')),
      });

      const client = new WrapperClient({ session, port: defaultPort });

      await expect(
        client.ensureRunning({
          sessionId: 'test-session',
          maxWaitMs: 100,
          pollIntervalMs: 10,
          kiloServerPort: 4600,
          workspacePath: '/workspace/test',
        })
      ).rejects.toThrow(WrapperNotReadyError);
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
          inflightCount: 0,
          version: '1.0.0',
        });
      });

      const client = new WrapperClient({ session, port: defaultPort });

      await client.ensureRunning({
        sessionId: 'test-session',
        pollIntervalMs: 10,
        maxWaitMs: 1000,
        kiloServerPort: 4600,
        workspacePath: '/workspace/test',
      });

      // Verify startProcess was called with the wrapper command
      expect(session.startProcess).toHaveBeenCalledTimes(1);
      const startProcessCall = (session.startProcess as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(startProcessCall[0]).toContain('kilocode-wrapper');
      expect(startProcessCall[0]).toContain('WRAPPER_PORT=5000');
      expect(startProcessCall[0]).toContain('KILO_SERVER_PORT=4600');
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
        createSuccessResponse({ healthy: true, state: 'idle', inflightCount: 0, version: '1.0.0' })
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
        createSuccessResponse({ healthy: true, state: 'idle', inflightCount: 0, version: '1.0.0' })
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
