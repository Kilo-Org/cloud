import { describe, expect, it, vi } from 'vitest';
import { type Component, type RefObject } from 'react';

import {
  applyBlockingCardAppearance,
  type BlockingCardA11yDeps,
  classifyBlockingSubmissionError,
  getBlockingCardPresentation,
  getBlockingCardPresentationForKind,
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

describe('applyBlockingCardAppearance', () => {
  function makeDeps(): BlockingCardA11yDeps {
    return {
      announce: vi.fn<(message: string) => void>(),
      focus: vi.fn<(ref: RefObject<Component | null>) => boolean>().mockReturnValue(true),
    };
  }

  it('invokes the announce helper with the presentation announcement on appearance', () => {
    const deps = makeDeps();
    const ref: RefObject<Component | null> = { current: null };
    const presentation = getBlockingCardPresentationForKind({
      kind: 'question',
      submissionError: null,
    });

    applyBlockingCardAppearance(presentation, ref, deps);

    expect(deps.announce).toHaveBeenCalledTimes(1);
    expect(deps.announce).toHaveBeenCalledWith(presentation.announcement);
  });

  it('moves a11y focus to the card ref on appearance', () => {
    const deps = makeDeps();
    const ref: RefObject<Component | null> = {
      current: { node: 'card' } as unknown as Component,
    };
    const presentation = getBlockingCardPresentationForKind({
      kind: 'permission',
      submissionError: null,
    });

    applyBlockingCardAppearance(presentation, ref, deps);

    expect(deps.focus).toHaveBeenCalledTimes(1);
    expect(deps.focus).toHaveBeenCalledWith(ref);
  });

  it('still announces when the focus move cannot find a node handle', () => {
    const deps: BlockingCardA11yDeps = {
      announce: vi.fn<(message: string) => void>(),
      focus: vi.fn<(ref: RefObject<Component | null>) => boolean>().mockReturnValue(false),
    };
    const ref: RefObject<Component | null> = { current: null };
    const presentation = getBlockingCardPresentationForKind({
      kind: 'question',
      submissionError: { kind: 'retryable', message: 'Try again', action: 'answer' },
    });

    const cleanup = applyBlockingCardAppearance(presentation, ref, deps);

    expect(deps.announce).toHaveBeenCalledWith(presentation.announcement);
    expect(deps.focus).toHaveBeenCalledWith(ref);
    expect(cleanup).toBeTypeOf('function');
  });

  it('retries focus once on the next tick when the first attempt misses the handle', () => {
    vi.useFakeTimers();
    const focusMock = vi.fn<(ref: RefObject<Component | null>) => boolean>();
    focusMock.mockReturnValueOnce(false).mockReturnValueOnce(true);
    const deps: BlockingCardA11yDeps = {
      announce: vi.fn<(message: string) => void>(),
      focus: focusMock,
    };
    const ref: RefObject<Component | null> = { current: null };
    const presentation = getBlockingCardPresentationForKind({
      kind: 'question',
      submissionError: null,
    });

    applyBlockingCardAppearance(presentation, ref, deps);
    expect(focusMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(50);
    expect(focusMock).toHaveBeenCalledTimes(2);
    expect(focusMock).toHaveBeenLastCalledWith(ref);

    vi.useRealTimers();
  });

  it('clears the pending retry when the cleanup function runs', () => {
    vi.useFakeTimers();
    const focusMock = vi.fn<(ref: RefObject<Component | null>) => boolean>().mockReturnValue(false);
    const deps: BlockingCardA11yDeps = {
      announce: vi.fn<(message: string) => void>(),
      focus: focusMock,
    };
    const ref: RefObject<Component | null> = { current: null };
    const presentation = getBlockingCardPresentationForKind({
      kind: 'permission',
      submissionError: null,
    });

    const cleanup = applyBlockingCardAppearance(presentation, ref, deps);
    cleanup?.();

    vi.advanceTimersByTime(50);
    expect(focusMock).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});
