import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockWarn, mockWithFields, mockWithTags } = vi.hoisted(() => {
  const warn = vi.fn();
  const withFields = vi.fn(() => ({ warn }));
  const withTags = vi.fn(() => ({ withFields }));
  return { mockWarn: warn, mockWithFields: withFields, mockWithTags: withTags };
});

vi.mock('./logger.js', () => ({
  logger: {
    withTags: mockWithTags,
  },
}));

import {
  isSandboxOperationTimeoutError,
  logSandboxOperationTimeout,
  withSandboxOperationTimeoutLog,
} from './sandbox-timeout-logging.js';

describe('sandbox timeout logging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('classifies known sandbox timeout messages conservatively', () => {
    expect(isSandboxOperationTimeoutError(new Error('Command timeout after 30000ms'))).toBe(true);
    expect(isSandboxOperationTimeoutError(new Error('Git clone timed out after 120000ms'))).toBe(
      true
    );
    expect(isSandboxOperationTimeoutError(new Error('Request timeout after 60000ms'))).toBe(true);
    expect(isSandboxOperationTimeoutError(new Error('Stream idle timeout after 10000ms'))).toBe(
      true
    );
    expect(
      isSandboxOperationTimeoutError(new Error('Process did not become ready within 30s'))
    ).toBe(true);
    expect(isSandboxOperationTimeoutError(new Error('Operation was aborted'))).toBe(false);
    expect(isSandboxOperationTimeoutError(new Error('authentication failed'))).toBe(false);
  });

  it('logs and rethrows timeout errors unchanged', async () => {
    const error = new Error('Command timeout after 30000ms');

    await expect(
      withSandboxOperationTimeoutLog(Promise.reject(error), {
        operation: 'session.runSetupCommand',
        timeoutMs: 30000,
        timeoutLayer: 'exec',
      })
    ).rejects.toBe(error);

    expect(mockWithTags).toHaveBeenCalledWith({ logTag: 'sandbox-operation-timeout' });
    expect(mockWithFields).toHaveBeenCalledWith({
      operation: 'session.runSetupCommand',
      timeoutMs: 30000,
      timeoutLayer: 'exec',
      error: 'Command timeout after 30000ms',
    });
    expect(mockWarn).toHaveBeenCalledWith('Sandbox operation timed out');
  });

  it('logs outer timeouts directly without requiring an error', () => {
    logSandboxOperationTimeout({
      operation: 'workspace.prepare:resume',
      timeoutMs: 300000,
      timeoutLayer: 'outer',
    });

    expect(mockWithFields).toHaveBeenCalledWith({
      operation: 'workspace.prepare:resume',
      timeoutMs: 300000,
      timeoutLayer: 'outer',
    });
    expect(mockWarn).toHaveBeenCalledWith('Sandbox operation timed out');
  });
});
