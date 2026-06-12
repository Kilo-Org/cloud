import { describe, expect, it } from 'vitest';
import { projectTerminalClientError } from './terminal-error-projector.js';

describe('projectTerminalClientError', () => {
  it('keeps runtime failures retryable after agent activity', () => {
    expect(
      projectTerminalClientError({
        status: 'failed',
        failureStage: 'agent_activity',
        failureCode: 'wrapper_error_after_activity',
        error: 'Provider stopped after editing files',
      })
    ).toEqual({
      code: 'WRAPPER_ERROR_AFTER_ACTIVITY',
      message: 'Provider stopped after editing files',
      retryable: true,
    });
  });

  it.each([
    'invalid_delivery_request',
    'session_metadata_missing',
    'model_missing',
    'payment_required',
    'user_interrupt',
  ] as const)('classifies %s as non-retryable regardless of stage', failureCode => {
    expect(
      projectTerminalClientError({
        status: 'failed',
        failureStage: 'pre_dispatch',
        failureCode,
      }).retryable
    ).toBe(false);
  });

  it.each(['assistant_error', 'wrapper_error_after_activity'] as const)(
    'classifies %s as retryable after agent activity',
    failureCode => {
      expect(
        projectTerminalClientError({
          status: 'failed',
          failureStage: 'agent_activity',
          failureCode,
        }).retryable
      ).toBe(true);
    }
  );

  it('defaults missing and unknown classifications to retryable', () => {
    expect(projectTerminalClientError({ status: 'failed' })).toEqual({
      code: 'EXECUTION_FAILED',
      message: 'Execution failed',
      retryable: true,
    });
    expect(
      projectTerminalClientError({
        status: 'interrupted',
        failureStage: 'unknown',
        failureCode: 'unclassified',
      })
    ).toEqual({
      code: 'UNCLASSIFIED',
      message: 'Execution interrupted',
      retryable: true,
    });
  });

  it('does not classify errors from their message text', () => {
    expect(
      projectTerminalClientError({ status: 'failed', error: 'assistant_error user_interrupt' })
    ).toEqual({
      code: 'EXECUTION_FAILED',
      message: 'assistant_error user_interrupt',
      retryable: true,
    });
  });
});
