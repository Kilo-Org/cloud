import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetNeedsInputReplyDraftForTests,
  clearNeedsInputReplyDraft,
  peekNeedsInputReplyDraft,
  rememberNeedsInputReplyDraft,
  subscribeNeedsInputReplyDraft,
  takeNeedsInputReplyDraft,
} from './needs-input-reply-draft';

describe('needs-input reply draft slot', () => {
  beforeEach(() => {
    _resetNeedsInputReplyDraftForTests();
  });

  it('offers a remembered answer once and empties the slot as it reads it', () => {
    rememberNeedsInputReplyDraft('session-1', 'ship it');

    expect(takeNeedsInputReplyDraft('session-1')).toBe('ship it');
    expect(takeNeedsInputReplyDraft('session-1')).toBeNull();
  });

  it('keeps each session answer apart', () => {
    rememberNeedsInputReplyDraft('session-1', 'ship it');
    rememberNeedsInputReplyDraft('session-2', 'hold it');

    expect(takeNeedsInputReplyDraft('session-2')).toBe('hold it');
    expect(takeNeedsInputReplyDraft('session-1')).toBe('ship it');
  });

  it('stores nothing for blank text', () => {
    rememberNeedsInputReplyDraft('session-1', '');
    rememberNeedsInputReplyDraft('session-1', '   \n\t ');

    expect(takeNeedsInputReplyDraft('session-1')).toBeNull();
  });

  it('drops an answer the screen chose not to offer', () => {
    rememberNeedsInputReplyDraft('session-1', 'ship it');

    clearNeedsInputReplyDraft('session-1');

    expect(takeNeedsInputReplyDraft('session-1')).toBeNull();
  });

  it('keeps the newest eight sessions and drops the oldest', () => {
    for (let index = 0; index < 9; index += 1) {
      rememberNeedsInputReplyDraft(`session-${index}`, `answer-${index}`);
    }

    expect(takeNeedsInputReplyDraft('session-0')).toBeNull();
    expect(takeNeedsInputReplyDraft('session-8')).toBe('answer-8');
    expect(takeNeedsInputReplyDraft('session-1')).toBe('answer-1');
  });

  it('counts a remembered session as newest when it is stored again', () => {
    for (let index = 0; index < 8; index += 1) {
      rememberNeedsInputReplyDraft(`session-${index}`, `answer-${index}`);
    }

    rememberNeedsInputReplyDraft('session-0', 'retry answer');
    rememberNeedsInputReplyDraft('session-8', 'answer-8');

    expect(takeNeedsInputReplyDraft('session-1')).toBeNull();
    expect(takeNeedsInputReplyDraft('session-0')).toBe('retry answer');
    expect(takeNeedsInputReplyDraft('session-8')).toBe('answer-8');
  });

  it('empties the slot on reset', () => {
    rememberNeedsInputReplyDraft('session-1', 'ship it');

    _resetNeedsInputReplyDraftForTests();

    expect(takeNeedsInputReplyDraft('session-1')).toBeNull();
  });

  it('reads a remembered answer without consuming it', () => {
    rememberNeedsInputReplyDraft('session-1', 'ship it');

    expect(peekNeedsInputReplyDraft('session-1')).toBe('ship it');
    expect(takeNeedsInputReplyDraft('session-1')).toBe('ship it');
    expect(peekNeedsInputReplyDraft('session-1')).toBeNull();
  });

  // A screen already on top learns about a reply stored after it mounted
  // through this subscription: no route change remounts it.
  it('notifies subscribers when the slot changes', () => {
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribeNeedsInputReplyDraft(listener);

    rememberNeedsInputReplyDraft('session-1', 'ship it');
    expect(listener).toHaveBeenCalledTimes(1);

    clearNeedsInputReplyDraft('session-1');
    expect(listener).toHaveBeenCalledTimes(2);

    rememberNeedsInputReplyDraft('session-1', 'ship it');
    takeNeedsInputReplyDraft('session-1');
    expect(listener).toHaveBeenCalledTimes(4);

    // Blank text stores nothing, so nothing changes.
    rememberNeedsInputReplyDraft('session-1', '  ');
    expect(listener).toHaveBeenCalledTimes(4);

    unsubscribe();
    rememberNeedsInputReplyDraft('session-1', 'ship it');
    expect(listener).toHaveBeenCalledTimes(4);
  });
});
