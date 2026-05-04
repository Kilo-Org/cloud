import { describe, expect, it } from 'vitest';

import { shouldStartReplyFromSwipe } from './message-gesture-state';

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
