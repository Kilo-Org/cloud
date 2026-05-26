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
  destroySandboxAfterPreparationInfrastructureFailure,
  getPreparationInfrastructureFailure,
  destroySandboxAfterInternalServerError,
  isSandboxInternalServerError,
  SANDBOX_WORKSPACE_PROBE_TIMEOUT_MESSAGE,
  withPreparationInfrastructureRecovery,
} from './sandbox-recovery.js';
import { WrapperNotReadyError } from './kilo/wrapper-client.js';
import { WorkspaceFilesystemPreparationError } from './workspace-errors.js';

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

  it('classifies wrapper not-ready errors caused by sandbox startup 500s', () => {
    const cause = new Error('Process exited before ready');
    Object.assign(cause, {
      name: 'ProcessExitedBeforeReadyError',
      httpStatus: 500,
    });

    const error = new WrapperNotReadyError('Wrapper did not become ready', { cause });

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
      withPreparationInfrastructureRecovery(
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

  it('classifies typed workspace filesystem preparation failures', () => {
    const cause = new Error('FileSystemError: mkdir operation failed with exit code NaN');
    const error = new WorkspaceFilesystemPreparationError(
      'workspace_directory',
      'Failed to create workspace directory: FileSystemError: mkdir operation failed with exit code NaN',
      cause
    );

    expect(getPreparationInfrastructureFailure(error)).toMatchObject({
      type: 'workspace_filesystem_preparation_error',
      error,
      message: error.message,
    });
  });

  it('destroys sandbox when preparation hits a workspace filesystem failure', async () => {
    const sandbox = { destroy: vi.fn().mockResolvedValue(undefined) };
    const cause = new Error('FileSystemError: mkdir operation failed with exit code NaN');
    const error = new WorkspaceFilesystemPreparationError(
      'session_home',
      'Failed to prepare session home: FileSystemError: mkdir operation failed with exit code NaN',
      cause
    );

    await expect(
      withPreparationInfrastructureRecovery(
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
      'Workspace filesystem preparation failed; destroying sandbox'
    );
    expect(mockInfo).toHaveBeenCalledWith(
      'Destroyed sandbox after workspace filesystem preparation failure'
    );
  });

  it('destroys sandbox when a workspace Git probe times out before bootstrap', async () => {
    const sandbox = { destroy: vi.fn().mockResolvedValue(undefined) };
    const error = new Error(`${SANDBOX_WORKSPACE_PROBE_TIMEOUT_MESSAGE} after 30000ms`);

    await expect(
      withPreparationInfrastructureRecovery(
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
      'Sandbox workspace Git probe timed out; destroying sandbox'
    );
    expect(mockInfo).toHaveBeenCalledWith('Destroyed sandbox after workspace Git probe timeout');
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

  it('does not destroy sandbox for unrelated preparation errors', async () => {
    const sandbox = { destroy: vi.fn().mockResolvedValue(undefined) };
    const destroyed = await destroySandboxAfterPreparationInfrastructureFailure(
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
