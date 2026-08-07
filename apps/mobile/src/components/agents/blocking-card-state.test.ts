import { describe, expect, it } from 'vitest';

import {
  classifyBlockingSubmissionError,
  formatBlockingCardTitle,
  getBlockingCardPresentation,
} from './blocking-card-state';

function makeTrpcError(code: string): unknown {
  return { data: { code } };
}

function makeNestedTrpcError(code: string): unknown {
  return { shape: { data: { code } } };
}

function makeTopLevelTrpcError(code: string): unknown {
  return { code };
}

describe('getBlockingCardPresentation', () => {
  it('returns null when no blocking interaction is active', () => {
    expect(getBlockingCardPresentation({ blocking: 'none', submissionError: null })).toBeNull();
  });

  describe('happy state', () => {
    it('exposes the primary CTA and no retry affordance for a question', () => {
      const presentation = getBlockingCardPresentation({
        blocking: 'question',
        submissionError: null,
      });

      expect(presentation).toEqual({
        kind: 'question',
        state: 'happy',
        announcement: expect.stringMatching(/needs your input/i),
        protocolExplanation: expect.stringMatching(/waiting for your answer/i),
        hasPrimaryCta: true,
        hasRetryCta: false,
        retryAction: null,
        hasRejectCta: true,
        errorMessage: null,
      });
    });

    it('exposes the primary CTA and never a reject CTA for a permission', () => {
      const presentation = getBlockingCardPresentation({
        blocking: 'permission',
        submissionError: null,
      });

      expect(presentation).toEqual({
        kind: 'permission',
        state: 'happy',
        announcement: expect.stringMatching(/needs permission/i),
        protocolExplanation: expect.stringMatching(/waiting for permission/i),
        hasPrimaryCta: true,
        hasRetryCta: false,
        retryAction: null,
        hasRejectCta: false,
        errorMessage: null,
      });
    });
  });

  describe('retryable state', () => {
    it('replaces the primary CTA with an answer retry affordance on a question', () => {
      const presentation = getBlockingCardPresentation({
        blocking: 'question',
        submissionError: { kind: 'retryable', message: 'Network hiccup', action: 'answer' },
      });

      expect(presentation?.state).toBe('retryable');
      expect(presentation?.hasPrimaryCta).toBe(false);
      expect(presentation?.hasRetryCta).toBe(true);
      expect(presentation?.retryAction).toBe('answer');
      expect(presentation?.hasRejectCta).toBe(true);
      expect(presentation?.errorMessage).toBe('Network hiccup');
      expect(presentation?.announcement).toMatch(/try again/i);
    });

    it('replaces the primary CTA with a reject retry affordance on a question and hides Skip', () => {
      const presentation = getBlockingCardPresentation({
        blocking: 'question',
        submissionError: { kind: 'retryable', message: 'Skip failed', action: 'reject' },
      });

      expect(presentation?.state).toBe('retryable');
      expect(presentation?.hasPrimaryCta).toBe(false);
      expect(presentation?.hasRetryCta).toBe(true);
      expect(presentation?.retryAction).toBe('reject');
      expect(presentation?.hasRejectCta).toBe(false);
      expect(presentation?.errorMessage).toBe('Skip failed');
    });

    it('replaces the primary CTA with a retry affordance on a permission', () => {
      const presentation = getBlockingCardPresentation({
        blocking: 'permission',
        submissionError: { kind: 'retryable', message: 'Try again', action: 'respond' },
      });

      expect(presentation?.state).toBe('retryable');
      expect(presentation?.hasPrimaryCta).toBe(false);
      expect(presentation?.hasRetryCta).toBe(true);
      expect(presentation?.retryAction).toBe('respond');
      expect(presentation?.hasRejectCta).toBe(false);
      expect(presentation?.errorMessage).toBe('Try again');
    });
  });

  describe('non-retryable state', () => {
    it('drops every CTA and surfaces an explanatory announcement for a question', () => {
      const presentation = getBlockingCardPresentation({
        blocking: 'question',
        submissionError: { kind: 'non-retryable', message: 'Request expired' },
      });

      expect(presentation?.state).toBe('non-retryable');
      expect(presentation?.hasPrimaryCta).toBe(false);
      expect(presentation?.hasRetryCta).toBe(false);
      expect(presentation?.retryAction).toBeNull();
      expect(presentation?.hasRejectCta).toBe(false);
      expect(presentation?.errorMessage).toBe('Request expired');
      expect(presentation?.announcement).toMatch(/no longer available/i);
      expect(presentation?.protocolExplanation).not.toMatch(/read-only/i);
    });

    it('drops every CTA and surfaces an explanatory announcement for a permission', () => {
      const presentation = getBlockingCardPresentation({
        blocking: 'permission',
        submissionError: { kind: 'non-retryable', message: 'Protocol ended' },
      });

      expect(presentation?.state).toBe('non-retryable');
      expect(presentation?.hasPrimaryCta).toBe(false);
      expect(presentation?.hasRetryCta).toBe(false);
      expect(presentation?.retryAction).toBeNull();
      expect(presentation?.hasRejectCta).toBe(false);
      expect(presentation?.errorMessage).toBe('Protocol ended');
    });
  });
});

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
