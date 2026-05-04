import { describe, expect, it } from 'vitest';

import {
  getSwipeReplyActiveOffsetX,
  resolveLongPressFeedback,
  shouldStartReplyFromSwipe,
} from './message-gesture-state';

describe('getSwipeReplyActiveOffsetX', () => {
  it('activates the message gesture only for left swipes', () => {
    expect(getSwipeReplyActiveOffsetX()).toEqual([-12, Number.MAX_SAFE_INTEGER]);
  });
});

describe('shouldStartReplyFromSwipe', () => {
  it('starts reply on a committed left swipe when reply is available', () => {
    expect(
      shouldStartReplyFromSwipe({
        canReply: true,
        translationX: -64,
        velocityX: -120,
      })
    ).toBe(true);
  });

  it('ignores short left drags and right swipes', () => {
    expect(
      shouldStartReplyFromSwipe({
        canReply: true,
        translationX: -24,
        velocityX: -100,
      })
    ).toBe(false);
    expect(
      shouldStartReplyFromSwipe({
        canReply: true,
        translationX: 72,
        velocityX: 500,
      })
    ).toBe(false);
  });

  it('ignores swipe gestures when the message cannot be replied to', () => {
    expect(
      shouldStartReplyFromSwipe({
        canReply: false,
        translationX: -80,
        velocityX: -700,
      })
    ).toBe(false);
  });
});

describe('resolveLongPressFeedback', () => {
  it('keeps press and long-press feedback subtle', () => {
    expect(resolveLongPressFeedback({ pressed: false, longPressed: false })).toEqual({
      scale: 1,
      highlightOpacity: 0,
    });
    expect(resolveLongPressFeedback({ pressed: true, longPressed: false })).toEqual({
      scale: 0.985,
      highlightOpacity: 0,
    });
    expect(resolveLongPressFeedback({ pressed: true, longPressed: true })).toEqual({
      scale: 0.97,
      highlightOpacity: 1,
    });
  });
});
