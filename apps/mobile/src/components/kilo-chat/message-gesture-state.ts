export const SWIPE_REPLY_DISTANCE = 56;
const SWIPE_REPLY_FAST_DISTANCE = 24;
const SWIPE_REPLY_FAST_VELOCITY = -650;
export const SWIPE_REPLY_MAX_TRANSLATE = 72;
const SWIPE_REPLY_ACTIVATION_DISTANCE = 12;
const LONG_PRESS_FEEDBACK_PRESS_SCALE = 0.985;
const LONG_PRESS_FEEDBACK_ACTIVE_SCALE = 0.97;
const LONG_PRESS_FEEDBACK_HIGHLIGHT_OPACITY = 1;

type SwipeReplyInput = {
  canReply: boolean;
  translationX: number;
  velocityX: number;
};

type LongPressFeedbackInput = {
  pressed: boolean;
  longPressed: boolean;
};

type LongPressFeedback = {
  scale: number;
  highlightOpacity: number;
};

export function getSwipeReplyActiveOffsetX(): [number, number] {
  return [-SWIPE_REPLY_ACTIVATION_DISTANCE, Number.MAX_SAFE_INTEGER];
}

export function shouldStartReplyFromSwipe({
  canReply,
  translationX,
  velocityX,
}: SwipeReplyInput): boolean {
  'worklet';

  if (!canReply || translationX >= 0) {
    return false;
  }

  const distance = Math.abs(translationX);
  return (
    distance >= SWIPE_REPLY_DISTANCE ||
    (distance >= SWIPE_REPLY_FAST_DISTANCE && velocityX <= SWIPE_REPLY_FAST_VELOCITY)
  );
}

export function resolveLongPressFeedback({
  pressed,
  longPressed,
}: LongPressFeedbackInput): LongPressFeedback {
  if (longPressed) {
    return {
      scale: LONG_PRESS_FEEDBACK_ACTIVE_SCALE,
      highlightOpacity: LONG_PRESS_FEEDBACK_HIGHLIGHT_OPACITY,
    };
  }
  if (pressed) {
    return {
      scale: LONG_PRESS_FEEDBACK_PRESS_SCALE,
      highlightOpacity: 0,
    };
  }
  return {
    scale: 1,
    highlightOpacity: 0,
  };
}
