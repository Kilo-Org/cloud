import { describe, expect, it, vi } from 'vitest';

const { mockError, mockInfo, mockWithFields } = vi.hoisted(() => {
  const error = vi.fn();
  const info = vi.fn();
  const withFields = vi.fn(() => ({ error, info }));
  return { mockError: error, mockInfo: info, mockWithFields: withFields };
});

vi.mock('./logger.js', () => ({
  logger: {
    withFields: mockWithFields,
  },
}));

import {
  destroySandboxAfterInternalServerError,
  isSandboxInternalServerError,
  withSandboxInternalServerErrorRecovery,
} from './sandbox-recovery.js';

describe('sandbox recovery', () => {
  it('classifies sandbox SDK internal server errors', () => {
    const error = new Error('control plane failed');
    Object.assign(error, {
      name: 'SandboxError',
      code: 'INTERNAL_ERROR',
      httpStatus: 500,
      errorResponse: {
        code: 'INTERNAL_ERROR',
        httpStatus: 500,
      },
    });

    expect(isSandboxInternalServerError(error)).toBe(true);
  });

  it('classifies nested wrapper failures caused by sandbox 500s', () => {
    const cause = new Error('HTTP error! status: 500');
    Object.assign(cause, { name: 'SandboxError' });
    const error = new Error('Failed to start wrapper: HTTP error! status: 500', { cause });
    Object.assign(error, {
      name: 'ExecutionError',
      code: 'WRAPPER_START_FAILED',
    });

    expect(isSandboxInternalServerError(error)).toBe(true);
  });

  it('does not classify execution errors by wrapper message alone', () => {
    const error = new Error('Failed to start wrapper: HTTP error! status: 500');
    Object.assign(error, {
      name: 'ExecutionError',
      code: 'WRAPPER_START_FAILED',
    });

    expect(isSandboxInternalServerError(error)).toBe(false);
  });

  it('does not classify regular internal errors as sandbox 500s', () => {
    expect(isSandboxInternalServerError(new Error('Internal server error'))).toBe(false);
    expect(isSandboxInternalServerError(new Error('Git clone failed'))).toBe(false);
  });

  it('does not classify workspace execution wrappers around non-sandbox 500s', () => {
    const cause = new Error('Upstream API failed with HTTP 500');
    const error = new Error('Failed to prepare workspace: Upstream API failed with HTTP 500', {
      cause,
    });
    Object.assign(error, {
      name: 'ExecutionError',
      code: 'WORKSPACE_SETUP_FAILED',
    });

    expect(isSandboxInternalServerError(error)).toBe(false);
  });

  it('does not classify plain HTTP 500 messages without sandbox context', () => {
    expect(isSandboxInternalServerError(new Error('HTTP error! status: 500'))).toBe(false);
  });

  it('destroys sandbox when a preparation operation throws a sandbox 500', async () => {
    const sandbox = { destroy: vi.fn().mockResolvedValue(undefined) };
    const error = new Error('HTTP error! status: 500');
    Object.assign(error, { name: 'SandboxError' });

    await expect(
      withSandboxInternalServerErrorRecovery(
        {
          sandbox,
          sandboxId: 'ses-test',
          sessionId: 'agent_test',
          phase: 'asyncPreparation',
        },
        async () => {
          throw error;
        }
      )
    ).rejects.toBe(error);

    expect(sandbox.destroy).toHaveBeenCalledOnce();
    expect(mockError).toHaveBeenCalledWith(
      'Sandbox returned 500 during workspace preparation; destroying sandbox'
    );
    expect(mockInfo).toHaveBeenCalledWith('Destroyed sandbox after workspace preparation 500');
  });

  it('does not destroy sandbox for unrelated errors', async () => {
    const sandbox = { destroy: vi.fn().mockResolvedValue(undefined) };
    const destroyed = await destroySandboxAfterInternalServerError(
      {
        sandbox,
        sandboxId: 'ses-test',
        sessionId: 'agent_test',
        phase: 'asyncPreparation',
      },
      new Error('Git clone failed')
    );

    expect(destroyed).toBe(false);
    expect(sandbox.destroy).not.toHaveBeenCalled();
  });
});
