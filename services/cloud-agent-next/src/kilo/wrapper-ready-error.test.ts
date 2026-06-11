import { describe, expect, it } from 'vitest';
import {
  isWrapperSessionReadyErrorResponse,
  parseWrapperSessionReadyErrorResponse,
} from './wrapper-ready-error.js';

describe('wrapper ready error parsing', () => {
  it('accepts structured and legacy wrapper errors', () => {
    expect(
      parseWrapperSessionReadyErrorResponse({
        error: 'WORKSPACE_SETUP_FAILED',
        subtype: 'git_clone_timeout',
        message: 'Repository clone timed out',
        detail: 'termination timeout, elapsed 120000ms, output truncated',
        retryable: true,
        wrapperRunId: 'wrapper_run_1',
      })
    ).toEqual({
      error: 'WORKSPACE_SETUP_FAILED',
      subtype: 'git_clone_timeout',
      message: 'Repository clone timed out',
      detail: 'termination timeout, elapsed 120000ms, output truncated',
      retryable: true,
      wrapperRunId: 'wrapper_run_1',
    });
    expect(
      isWrapperSessionReadyErrorResponse({ error: 'WORKSPACE_SETUP_FAILED', message: 'old' })
    ).toBe(true);
  });

  it.each([
    {
      error: 'WORKSPACE_SETUP_FAILED',
      subtype: 'not_allowed',
      message: 'bad',
    },
    {
      error: 'WORKSPACE_SETUP_FAILED',
      message: 'm'.repeat(4_097),
    },
    {
      error: 'WORKSPACE_SETUP_FAILED',
      message: 'bounded',
      detail: 'd'.repeat(8_193),
    },
    {
      error: 'WORKSPACE_SETUP_FAILED',
      message: 'bounded',
      retryable: 'false',
    },
    {
      error: 'WORKSPACE_SETUP_FAILED',
      message: 'bounded',
      wrapperRunId: 42,
    },
  ])('rejects malformed wrapper error %#', value => {
    expect(isWrapperSessionReadyErrorResponse(value)).toBe(false);
  });
});
