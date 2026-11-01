import { View } from 'react-native';
import Animated, { FadeOut } from 'react-native-reanimated';

import { BlurBar } from '@/components/ui/blur-bar';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Bubble height classes. The transcript is anchored to its newest message, so
 * the placeholder is read bottom-up: the last entry is the bubble nearest the
 * composer.
 */
const SHAPES = [
  ['h-24', 'h-10', 'h-16'],
  ['h-16', 'h-8', 'h-24'],
  ['h-12', 'h-20', 'h-10'],
  ['h-20', 'h-12', 'h-14'],
] as const;

/** Stable per-session shape, so a reopen looks the same and a different session does not. */
function shapeFor(sessionId: string) {
  const hash = Array.from(sessionId, (char: string) => char.codePointAt(0) ?? 0).reduce(
    (acc, code) => (acc * 31 + code) % 1024,
    0
  );
  return SHAPES[hash % SHAPES.length] ?? SHAPES[0];
}

/**
 * Mirrors MessageBubble's geometry (px-4 py-1 wrapper, rounded-2xl with an
 * asymmetric "tail" corner, self-start/self-end alignment) so the loading
 * state reads as a message list, not a spinner.
 *
 * `justify-end` matters: the real list is a FlashList with
 * `startRenderingFromBottom`, so a top-anchored placeholder would drop the
 * whole transcript from the top of the screen to the bottom on first paint.
 *
 * The bubbles are the list's flex items, not the rows of a nested column: each
 * one carries its own margin and alignment, so `shrink` acts on a definite
 * height. A body shorter than the three bubbles then compresses them, and
 * `overflow-hidden` keeps whatever is left inside the body instead of painting
 * over the row below it — a placeholder is never sliced by the status line.
 */
export function SessionSkeletonMessages({ sessionId }: Readonly<{ sessionId?: string }>) {
  const [first, second, third] = shapeFor(sessionId ?? '');
  return (
    <Animated.View
      exiting={FadeOut.duration(150)}
      className="flex-1 justify-end overflow-hidden px-4 pb-2"
    >
      <Skeleton className={`my-1 w-3/4 shrink self-start rounded-2xl rounded-tl-sm ${first}`} />
      <Skeleton className={`my-1 w-1/2 shrink self-end rounded-2xl rounded-tr-sm ${second}`} />
      <Skeleton className={`my-1 w-2/3 shrink self-start rounded-2xl rounded-tl-sm ${third}`} />
    </Animated.View>
  );
}

/**
 * Holds the read-only footer's place while the session's transcript and
 * transport are still resolving. Until the transport answers, the screen cannot
 * know whether the bottom slot ends in the composer or in the read-only footer,
 * so the loading state reserves the footer's area — a line and a button bar in
 * the footer's own container — instead of offering a composer that a read-only
 * session will not have. The footer then lands on its own geometry and the
 * transcript never moves under it.
 *
 * The bars take `bg-muted-soft`: the theme's `muted` equals `secondary` in both
 * palettes, so default-tone bars on this footer's own fill paint nothing and
 * the reserved area read as a blank tinted block. The line is the footer note's
 * `text-sm` line box and the bar its `action` button's 48pt floor.
 */
export function SessionReadOnlyFooterPlaceholder() {
  return (
    <View className="gap-3 border-t border-border bg-secondary px-4 py-3">
      <Skeleton className="mx-auto h-[17.5px] w-40 bg-muted-soft" />
      <Skeleton className="h-[48px] bg-muted-soft" />
    </View>
  );
}

/**
 * Holds the composer's place while the session loads. Without it the composer
 * pops in on resolve and shoves the transcript up by its own height.
 * Geometry follows ChatComposer: a BlurBar wrapping the input row's
 * `p-2.5 px-3`.
 */
export function SessionComposerSkeleton() {
  return (
    <BlurBar>
      <View className="flex-row items-center p-2.5 px-3">
        <Skeleton className="h-9 flex-1 rounded-2xl" />
      </View>
    </BlurBar>
  );
}
