export const SWIPE_REPLY_DISTANCE = 56;
export const SWIPE_REPLY_FAST_DISTANCE = 24;
export const SWIPE_REPLY_FAST_VELOCITY = -650;
export const SWIPE_REPLY_MAX_TRANSLATE = 72;

type SwipeReplyInput = {
  canReply: boolean;
  translationX: number;
  velocityX: number;
};

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
