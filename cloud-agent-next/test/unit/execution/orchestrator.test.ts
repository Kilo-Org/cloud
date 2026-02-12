/**
 * Unit tests for ExecutionOrchestrator types and ExecutionError.
 *
 * Note: The ExecutionOrchestrator class itself requires complex mocking of
 * cloudflare-specific types (@cloudflare/containers, DurableObjectStub, etc.)
 * which have module resolution issues in vitest's Node environment.
 *
 * This file focuses on testing:
 * - ExecutionError class and factory methods
 * - isExecutionError type guard
 * - ExecutionPlan type structure
 * - WorkspacePlan variants
 * - Error code classification
 *
 * Full integration testing of ExecutionOrchestrator is done via
 * integration tests that run in the Cloudflare Workers environment.
 */

import { describe, expect, it } from 'vitest';
import {
  ExecutionError,
  isExecutionError,
  type RetryableErrorCode,
  type ConflictErrorCode,
  type PermanentErrorCode,
} from '../../../src/execution/errors.js';
import type {
  ExecutionPlan,
  ExecutionResult,
  WorkspacePlan,
  ModelConfig,
  ResumeContext,
  InitContext,
  ExistingSessionMetadata,
  WrapperPlan,
} from '../../../src/execution/types.js';

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

const createResumeWorkspacePlan = (): WorkspacePlan => ({
  shouldPrepare: false,
  sandboxId: 'sandbox_123',
  resumeContext: {
    kiloSessionId: 'kilo_sess_456',
    workspacePath: '/workspace/project',
    kilocodeToken: 'kilo_token',
    branchName: 'feature-branch',
  },
});

const createInitWorkspacePlan = (): WorkspacePlan => ({
  shouldPrepare: true,
  sandboxId: 'sandbox_123',
  initContext: {
    githubRepo: 'owner/repo',
    githubToken: 'gh_token',
    kilocodeToken: 'kilo_token',
    kilocodeModel: 'anthropic/claude-sonnet-4-20250514',
  },
});

const createPreparedWorkspacePlan = (): WorkspacePlan => ({
  shouldPrepare: true,
  sandboxId: 'sandbox_123',
  initContext: {
    githubRepo: 'owner/repo',
    githubToken: 'gh_token',
    kilocodeToken: 'kilo_token',
    isPreparedSession: true,
    kiloSessionId: 'kilo_sess_existing',
  },
  existingMetadata: {
    workspacePath: '/workspace/project',
    kiloSessionId: 'kilo_sess_existing',
    branchName: 'main',
    sandboxId: 'sandbox_123',
    sessionHome: '/home/agent',
  },
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ExecutionError', () => {
  // -------------------------------------------------------------------------
  // Factory Methods - Retryable Errors
  // -------------------------------------------------------------------------

  describe('retryable error factory methods', () => {
    it('sandboxConnectFailed creates retryable error', () => {
      const error = ExecutionError.sandboxConnectFailed('Connection refused');

      expect(error.code).toBe('SANDBOX_CONNECT_FAILED');
      expect(error.retryable).toBe(true);
      expect(error.message).toBe('Connection refused');
      expect(error.name).toBe('ExecutionError');
    });

    it('workspaceSetupFailed creates retryable error', () => {
      const error = ExecutionError.workspaceSetupFailed('Git clone failed');

      expect(error.code).toBe('WORKSPACE_SETUP_FAILED');
      expect(error.retryable).toBe(true);
    });

    it('kiloServerFailed creates retryable error', () => {
      const error = ExecutionError.kiloServerFailed('Server starting');

      expect(error.code).toBe('KILO_SERVER_FAILED');
      expect(error.retryable).toBe(true);
    });

    it('wrapperStartFailed creates retryable error', () => {
      const error = ExecutionError.wrapperStartFailed('Wrapper timeout');

      expect(error.code).toBe('WRAPPER_START_FAILED');
      expect(error.retryable).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Factory Methods - Conflict Errors
  // -------------------------------------------------------------------------

  describe('conflict error factory methods', () => {
    it('executionInProgress creates conflict error', () => {
      const error = ExecutionError.executionInProgress('exc_active');

      expect(error.code).toBe('EXECUTION_IN_PROGRESS');
      expect(error.retryable).toBe(false);
      expect(error.activeExecutionId).toBe('exc_active');
      expect(error.message).toContain('exc_active');
    });
  });

  // -------------------------------------------------------------------------
  // Factory Methods - Permanent Errors
  // -------------------------------------------------------------------------

  describe('permanent error factory methods', () => {
    it('invalidRequest creates non-retryable error', () => {
      const error = ExecutionError.invalidRequest('Missing field');

      expect(error.code).toBe('INVALID_REQUEST');
      expect(error.retryable).toBe(false);
    });

    it('sessionNotFound creates non-retryable error', () => {
      const error = ExecutionError.sessionNotFound('session_abc');

      expect(error.code).toBe('SESSION_NOT_FOUND');
      expect(error.retryable).toBe(false);
      expect(error.message).toContain('session_abc');
    });

    it('wrapperJobConflict creates non-retryable error', () => {
      const error = ExecutionError.wrapperJobConflict('Already running');

      expect(error.code).toBe('WRAPPER_JOB_CONFLICT');
      expect(error.retryable).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Cause Preservation
  // -------------------------------------------------------------------------

  describe('cause preservation', () => {
    it('preserves cause for debugging', () => {
      const originalError = new Error('Original problem');
      const error = ExecutionError.sandboxConnectFailed('Wrapped', originalError);

      expect(error.cause).toBe(originalError);
    });

    it('works without cause', () => {
      const error = ExecutionError.sandboxConnectFailed('No cause');

      expect(error.cause).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Error Code Classification
  // -------------------------------------------------------------------------

  describe('error code classification', () => {
    const retryableCodes: RetryableErrorCode[] = [
      'SANDBOX_CONNECT_FAILED',
      'WORKSPACE_SETUP_FAILED',
      'KILO_SERVER_FAILED',
      'WRAPPER_START_FAILED',
    ];

    it.each(retryableCodes)('%s is retryable', code => {
      let error: ExecutionError;
      switch (code) {
        case 'SANDBOX_CONNECT_FAILED':
          error = ExecutionError.sandboxConnectFailed('test');
          break;
        case 'WORKSPACE_SETUP_FAILED':
          error = ExecutionError.workspaceSetupFailed('test');
          break;
        case 'KILO_SERVER_FAILED':
          error = ExecutionError.kiloServerFailed('test');
          break;
        case 'WRAPPER_START_FAILED':
          error = ExecutionError.wrapperStartFailed('test');
          break;
      }

      expect(error.retryable).toBe(true);
    });

    it('EXECUTION_IN_PROGRESS is not retryable', () => {
      const error = ExecutionError.executionInProgress('exc_123');
      expect(error.retryable).toBe(false);
    });

    it('INVALID_REQUEST is not retryable', () => {
      const error = ExecutionError.invalidRequest('Bad input');
      expect(error.retryable).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// isExecutionError Type Guard
// ---------------------------------------------------------------------------

describe('isExecutionError', () => {
  it('returns true for ExecutionError instances', () => {
    const error = ExecutionError.sandboxConnectFailed('test');
    expect(isExecutionError(error)).toBe(true);
  });

  it('returns false for regular Error', () => {
    const error = new Error('test');
    expect(isExecutionError(error)).toBe(false);
  });

  it('returns false for non-error values', () => {
    expect(isExecutionError(null)).toBe(false);
    expect(isExecutionError(undefined)).toBe(false);
    expect(isExecutionError('string')).toBe(false);
    expect(isExecutionError({ code: 'FAKE' })).toBe(false);
    expect(isExecutionError(42)).toBe(false);
  });

  it('returns false for Error subclass with code property', () => {
    class CustomError extends Error {
      code = 'SANDBOX_CONNECT_FAILED';
    }
    const error = new CustomError('test');
    expect(isExecutionError(error)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WorkspacePlan Type Tests
// ---------------------------------------------------------------------------

describe('WorkspacePlan types', () => {
  it('distinguishes resume vs init via shouldPrepare', () => {
    const resumePlan = createResumeWorkspacePlan();
    const initPlan = createInitWorkspacePlan();

    expect(resumePlan.shouldPrepare).toBe(false);
    expect(initPlan.shouldPrepare).toBe(true);
  });

  it('resume plan has resumeContext', () => {
    const plan = createResumeWorkspacePlan();

    if (!plan.shouldPrepare) {
      expect(plan.resumeContext).toBeDefined();
      expect(plan.resumeContext.kiloSessionId).toBeDefined();
      expect(plan.resumeContext.workspacePath).toBeDefined();
      expect(plan.resumeContext.kilocodeToken).toBeDefined();
      expect(plan.resumeContext.branchName).toBeDefined();
    }
  });

  it('init plan has initContext', () => {
    const plan = createInitWorkspacePlan();

    if (plan.shouldPrepare) {
      expect(plan.initContext).toBeDefined();
      expect(plan.initContext.kilocodeToken).toBeDefined();
    }
  });

  it('prepared plan has both initContext and existingMetadata', () => {
    const plan = createPreparedWorkspacePlan();

    if (plan.shouldPrepare) {
      expect(plan.initContext).toBeDefined();
      expect(plan.initContext.isPreparedSession).toBe(true);
      expect(plan.existingMetadata).toBeDefined();
      expect(plan.existingMetadata?.workspacePath).toBeDefined();
    }
  });

  it('resume context can have optional token overrides', () => {
    const context: ResumeContext = {
      kiloSessionId: 'kilo_sess',
      workspacePath: '/workspace',
      kilocodeToken: 'token',
      branchName: 'main',
      githubToken: 'gh_token_override',
      gitToken: 'git_token_override',
    };

    expect(context.githubToken).toBe('gh_token_override');
    expect(context.gitToken).toBe('git_token_override');
  });

  it('init context supports all optional fields', () => {
    const context: InitContext = {
      kilocodeToken: 'token',
      githubRepo: 'owner/repo',
      gitUrl: 'https://git.example.com/repo.git',
      githubToken: 'gh_token',
      gitToken: 'git_token',
      envVars: { NODE_ENV: 'production' },
      setupCommands: ['npm install'],
      upstreamBranch: 'main',
      kiloSessionId: 'kilo_sess',
      isPreparedSession: true,
      kilocodeModel: 'anthropic/claude-sonnet-4-20250514',
      botId: 'bot_123',
      githubAppType: 'standard',
    };

    expect(context.githubAppType).toBe('standard');
    expect(context.botId).toBe('bot_123');
  });
});

// ---------------------------------------------------------------------------
// ExecutionResult Type Tests
// ---------------------------------------------------------------------------

describe('ExecutionResult types', () => {
  it('contains kiloSessionId', () => {
    const result: ExecutionResult = {
      kiloSessionId: 'kilo_sess_456',
    };

    expect(result.kiloSessionId).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// ModelConfig Type Tests
// ---------------------------------------------------------------------------

describe('ModelConfig types', () => {
  it('requires modelID', () => {
    const model: ModelConfig = {
      modelID: 'anthropic/claude-sonnet-4-20250514',
    };

    expect(model.modelID).toBeDefined();
  });

  it('accepts optional providerID', () => {
    const modelWithProvider: ModelConfig = {
      providerID: 'kilo',
      modelID: 'anthropic/claude-sonnet-4-20250514',
    };

    expect(modelWithProvider.providerID).toBe('kilo');
  });
});

// ---------------------------------------------------------------------------
// WrapperPlan Type Tests
// ---------------------------------------------------------------------------

describe('WrapperPlan types', () => {
  it('accepts all optional fields', () => {
    const plan: WrapperPlan = {
      kiloSessionId: 'kilo_sess',
      kiloSessionTitle: 'My Session',
      model: { modelID: 'anthropic/claude-sonnet-4-20250514' },
      autoCommit: true,
      condenseOnComplete: true,
    };

    expect(plan.kiloSessionId).toBe('kilo_sess');
    expect(plan.autoCommit).toBe(true);
  });

  it('works with minimal fields', () => {
    const plan: WrapperPlan = {};

    expect(plan.kiloSessionId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ExistingSessionMetadata Type Tests
// ---------------------------------------------------------------------------

describe('ExistingSessionMetadata types', () => {
  it('has required fields', () => {
    const metadata: ExistingSessionMetadata = {
      workspacePath: '/workspace/project',
      kiloSessionId: 'kilo_sess',
      branchName: 'main',
    };

    expect(metadata.workspacePath).toBeDefined();
    expect(metadata.kiloSessionId).toBeDefined();
    expect(metadata.branchName).toBeDefined();
  });

  it('accepts optional fields', () => {
    const metadata: ExistingSessionMetadata = {
      workspacePath: '/workspace/project',
      kiloSessionId: 'kilo_sess',
      branchName: 'main',
      sandboxId: 'sandbox_123',
      sessionHome: '/home/agent',
      upstreamBranch: 'develop',
      appendSystemPrompt: 'Additional instructions',
      githubRepo: 'owner/repo',
      gitUrl: 'https://git.example.com/repo.git',
    };

    expect(metadata.sandboxId).toBe('sandbox_123');
    expect(metadata.appendSystemPrompt).toBe('Additional instructions');
  });
});
