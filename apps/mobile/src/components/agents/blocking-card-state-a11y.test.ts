import { describe, expect, it, vi } from 'vitest';
import { type RefObject } from 'react';
import { type HostInstance } from 'react-native';

import {
  applyBlockingCardAppearance,
  type BlockingCardA11yDeps,
  getBlockingCardPresentationForKind,
} from './blocking-card-state';

function makeDeps(): BlockingCardA11yDeps {
  return {
    announce: vi.fn<(message: string) => void>(),
    focus: vi.fn<(ref: RefObject<HostInstance | null>) => boolean>().mockReturnValue(true),
  };
}

describe('applyBlockingCardAppearance', () => {
  it('invokes the announce helper with the presentation announcement on appearance', () => {
    const deps = makeDeps();
    const ref: RefObject<HostInstance | null> = { current: null };
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
    const node: Partial<HostInstance> = {};
    const ref: RefObject<HostInstance | null> = { current: node as HostInstance };
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
      focus: vi.fn<(ref: RefObject<HostInstance | null>) => boolean>().mockReturnValue(false),
    };
    const ref: RefObject<HostInstance | null> = { current: null };
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
    const focusMock = vi.fn<(ref: RefObject<HostInstance | null>) => boolean>();
    focusMock.mockReturnValueOnce(false).mockReturnValueOnce(true);
    const deps: BlockingCardA11yDeps = {
      announce: vi.fn<(message: string) => void>(),
      focus: focusMock,
    };
    const ref: RefObject<HostInstance | null> = { current: null };
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
    const focusMock = vi
      .fn<(ref: RefObject<HostInstance | null>) => boolean>()
      .mockReturnValue(false);
    const deps: BlockingCardA11yDeps = {
      announce: vi.fn<(message: string) => void>(),
      focus: focusMock,
    };
    const ref: RefObject<HostInstance | null> = { current: null };
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
