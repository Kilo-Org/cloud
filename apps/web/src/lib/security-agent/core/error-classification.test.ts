import { describe, expect, it } from '@jest/globals';
import {
  classifyAnalysisError,
  isUserActionableError,
  trpcCodeForAnalysisError,
} from './error-classification';
import type { AnalysisErrorCode } from './error-classification';

describe('classifyAnalysisError', () => {
  describe('CLONE_FAILED', () => {
    it.each([
      'fatal: git clone https://github.com/foo/bar failed',
      'Failed to clone repository',
      'failed to clone foo/bar',
      'Could not read repository from remote',
    ])('classifies %j as CLONE_FAILED', message => {
      expect(classifyAnalysisError(new Error(message)).code).toBe('CLONE_FAILED');
    });

    it('does not match unrelated uses of "clone"', () => {
      // "structured clone algorithm" should NOT match
      expect(classifyAnalysisError(new Error('structured clone algorithm failed')).code).not.toBe(
        'CLONE_FAILED'
      );
    });
  });

  describe('AUTH_FAILED', () => {
    it.each([
      'Bad credentials',
      'Authentication failed for repo',
      'credential rejected by server',
      'credentials expired',
      'HTTP status: 401',
      'error: 403',
      'permission denied',
    ])('classifies %j as AUTH_FAILED', message => {
      expect(classifyAnalysisError(new Error(message)).code).toBe('AUTH_FAILED');
    });
  });

  describe('REPO_NOT_FOUND', () => {
    it.each([
      'repository not found',
      'repo not found',
      'Not found - repo foo/bar',
      '404 repo not available',
      'repository 404',
      'Repository does not exist',
      'no such repository: foo/bar',
    ])('classifies %j as REPO_NOT_FOUND', message => {
      expect(classifyAnalysisError(new Error(message)).code).toBe('REPO_NOT_FOUND');
    });

    it('does not match generic "not found" without repo context', () => {
      expect(classifyAnalysisError(new Error('Module not found')).code).not.toBe('REPO_NOT_FOUND');
      expect(classifyAnalysisError(new Error('Config file not found')).code).not.toBe(
        'REPO_NOT_FOUND'
      );
    });

    it('does not match generic 404 without repo context', () => {
      expect(classifyAnalysisError(new Error('HTTP 404: endpoint not found')).code).not.toBe(
        'REPO_NOT_FOUND'
      );
    });

    it('does not match generic "does not exist" without repo context', () => {
      expect(classifyAnalysisError(new Error('file does not exist')).code).not.toBe(
        'REPO_NOT_FOUND'
      );
      expect(classifyAnalysisError(new Error('branch does not exist')).code).not.toBe(
        'REPO_NOT_FOUND'
      );
    });
  });

  describe('SANDBOX_FAILED', () => {
    it.each([
      'ConfigInvalidError: bad file reference: "{file:.opencode/prompts/agents/planner.txt}"',
      'Failed to create workspace directory /tmp/sandbox-123',
      'Failed to create kilo CLI session for repo foo/bar',
      'prepareSession call failed with HTTP 500',
      'FileSystemError: mkdir operation failed with exit code NaN',
    ])('classifies %j as SANDBOX_FAILED', message => {
      expect(classifyAnalysisError(new Error(message)).code).toBe('SANDBOX_FAILED');
    });

    it('does not match generic filesystem or config errors without sandbox context', () => {
      expect(classifyAnalysisError(new Error('Invalid config option')).code).not.toBe(
        'SANDBOX_FAILED'
      );
      expect(classifyAnalysisError(new Error('ENOENT: no such file or directory')).code).not.toBe(
        'SANDBOX_FAILED'
      );
    });
  });

  describe('UNKNOWN', () => {
    it('returns UNKNOWN for unrecognized errors', () => {
      const result = classifyAnalysisError(new Error('something unexpected'));
      expect(result.code).toBe('UNKNOWN');
    });

    it('returns a generic message instead of the raw error', () => {
      const result = classifyAnalysisError(new Error('internal path: /var/secrets/key.pem'));
      expect(result.userMessage).toBe('An unexpected error occurred. Please try again.');
      expect(result.userMessage).not.toContain('/var/secrets');
    });

    it('handles non-Error values', () => {
      expect(classifyAnalysisError('string error').code).toBe('UNKNOWN');
      expect(classifyAnalysisError(42).code).toBe('UNKNOWN');
      expect(classifyAnalysisError(null).code).toBe('UNKNOWN');
    });
  });

  describe('priority ordering', () => {
    it('classifies a clone error containing "not found" as CLONE_FAILED', () => {
      const result = classifyAnalysisError(
        new Error('failed to clone: repository not found on remote')
      );
      expect(result.code).toBe('CLONE_FAILED');
    });

    it('classifies a clone error with auth substring as CLONE_FAILED', () => {
      const result = classifyAnalysisError(new Error('git clone failed: authentication required'));
      expect(result.code).toBe('CLONE_FAILED');
    });
  });
});

describe('isUserActionableError', () => {
  it.each<[AnalysisErrorCode, boolean]>([
    ['CLONE_FAILED', true],
    ['AUTH_FAILED', true],
    ['REPO_NOT_FOUND', true],
    ['SANDBOX_FAILED', false],
    ['UNKNOWN', false],
  ])('%s → isUserActionable = %s', (code, expected) => {
    expect(isUserActionableError(code)).toBe(expected);
  });
});

describe('trpcCodeForAnalysisError', () => {
  it.each<[AnalysisErrorCode | undefined, string]>([
    ['CLONE_FAILED', 'BAD_REQUEST'],
    ['AUTH_FAILED', 'PRECONDITION_FAILED'],
    ['REPO_NOT_FOUND', 'NOT_FOUND'],
    ['SANDBOX_FAILED', 'INTERNAL_SERVER_ERROR'],
    ['UNKNOWN', 'INTERNAL_SERVER_ERROR'],
    [undefined, 'INTERNAL_SERVER_ERROR'],
  ])('%s → trpcCode = %s', (code, expected) => {
    expect(trpcCodeForAnalysisError(code)).toBe(expected);
  });
});
