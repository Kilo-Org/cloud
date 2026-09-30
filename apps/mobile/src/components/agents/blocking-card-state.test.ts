import { describe, expect, it } from 'vitest';

import { classifyBlockingSubmissionError, formatBlockingCardTitle } from './blocking-card-state';

function makeTrpcError(code: string): unknown {
  return { data: { code } };
}

function makeNestedTrpcError(code: string): unknown {
  return { shape: { data: { code } } };
}

function makeTopLevelTrpcError(code: string): unknown {
  return { code };
}

describe('classifyBlockingSubmissionError', () => {
  it('classifies tRPC NOT_FOUND as non-retryable', () => {
    expect(classifyBlockingSubmissionError(makeTrpcError('NOT_FOUND'), 'question')).toEqual({
      kind: 'non-retryable',
      message: 'This question is no longer available.',
    });
    expect(classifyBlockingSubmissionError(makeTrpcError('NOT_FOUND'), 'permission')).toEqual({
      kind: 'non-retryable',
      message: 'This permission request is no longer available.',
    });
  });

  it('reads the terminal code from nested shape and top-level forms', () => {
    expect(classifyBlockingSubmissionError(makeNestedTrpcError('NOT_FOUND'), 'question')).toEqual({
      kind: 'non-retryable',
      message: 'This question is no longer available.',
    });
    expect(
      classifyBlockingSubmissionError(makeTopLevelTrpcError('NOT_FOUND'), 'permission')
    ).toEqual({
      kind: 'non-retryable',
      message: 'This permission request is no longer available.',
    });
  });

  it('classifies tRPC transient errors as retryable with answer action by default', () => {
    expect(
      classifyBlockingSubmissionError(makeTrpcError('INTERNAL_SERVER_ERROR'), 'question')
    ).toEqual({
      kind: 'retryable',
      message: 'Failed to submit answer. Please try again.',
      action: 'answer',
    });
    expect(
      classifyBlockingSubmissionError(makeTrpcError('PRECONDITION_FAILED'), 'permission')
    ).toEqual({
      kind: 'retryable',
      message: 'Failed to respond to permission. Please try again.',
      action: 'answer',
    });
    expect(classifyBlockingSubmissionError(makeTrpcError('TIMEOUT'), 'question')).toEqual({
      kind: 'retryable',
      message: 'Failed to submit answer. Please try again.',
      action: 'answer',
    });
  });

  it('classifies question reject failures with skip-appropriate messaging', () => {
    expect(
      classifyBlockingSubmissionError(makeTrpcError('INTERNAL_SERVER_ERROR'), 'question', 'reject')
    ).toEqual({
      kind: 'retryable',
      message: 'Failed to skip question. Please try again.',
      action: 'reject',
    });
  });

  it('classifies permission failures with respond action', () => {
    expect(
      classifyBlockingSubmissionError(makeTrpcError('TIMEOUT'), 'permission', 'respond')
    ).toEqual({
      kind: 'retryable',
      message: 'Failed to respond to permission. Please try again.',
      action: 'respond',
    });
  });

  it('classifies non-tRPC errors as retryable', () => {
    expect(classifyBlockingSubmissionError(new Error('network down'), 'question')).toEqual({
      kind: 'retryable',
      message: 'Failed to submit answer. Please try again.',
      action: 'answer',
    });
    expect(classifyBlockingSubmissionError('string error', 'permission')).toEqual({
      kind: 'retryable',
      message: 'Failed to respond to permission. Please try again.',
      action: 'answer',
    });
    expect(classifyBlockingSubmissionError(null, 'question')).toEqual({
      kind: 'retryable',
      message: 'Failed to submit answer. Please try again.',
      action: 'answer',
    });
  });
});

describe('formatBlockingCardTitle', () => {
  it('returns the base title unchanged for count 0', () => {
    expect(formatBlockingCardTitle('Permission required', 0)).toBe('Permission required');
  });

  it('returns the base title unchanged for count 1', () => {
    expect(formatBlockingCardTitle('Agent needs input', 1)).toBe('Agent needs input');
  });

  it('appends a position hint when more than one request waits', () => {
    expect(formatBlockingCardTitle('Permission required', 3)).toBe('Permission required (1 of 3)');
    expect(formatBlockingCardTitle('Agent needs input', 2)).toBe('Agent needs input (1 of 2)');
  });
});
