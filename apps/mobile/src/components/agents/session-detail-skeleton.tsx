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

/**
 * One placeholder bubble's geometry: MessageBubble's `px-4 py-1` wrapper, its
 * width, its self-alignment, and the asymmetric "tail" corner. The three
 * entries cycle top-down, so the final entry is the newest bubble, just above
 * the composer.
 */
const BUBBLE_LAYOUT = [
  { align: 'items-start', width: 'w-3/4', tail: 'rounded-tl-sm' },
  { align: 'items-end', width: 'w-1/2', tail: 'rounded-tr-sm' },
  { align: 'items-start', width: 'w-2/3', tail: 'rounded-tl-sm' },
] as const;

/**
 * How many times the three-bubble layout repeats. Three bubbles cover only the
 * bottom of the transcript region and leave the rest of it blank, so the
 * column has to overflow the region and be clipped at its top edge to read as
 * a full-page loader. The shortest shape is `168px` per repeat plus the
 * wrappers' `py-1`, so eight repeats is at least `1536px` — taller than the
 * transcript region on any phone. Only the heights come from the per-session
 * hash, so a reopen looks the same and a different session does not.
 */
const SHAPE_REPEATS = 8;
const BUBBLE_COUNT = SHAPE_REPEATS * BUBBLE_LAYOUT.length;

/** Stable per-session shape, so a reopen looks the same and a different session does not. */
function shapeFor(sessionId: string) {
  const hash = Array.from(sessionId, (char: string) => char.codePointAt(0) ?? 0).reduce(
    (acc, code) => (acc * 31 + code) % 1024,
    0
  );
  return SHAPES[hash % SHAPES.length] ?? SHAPES[0];
}

type SkeletonBubble = {
  key: string;
  align: string;
  width: string;
  tail: string;
  height: string;
};

/**
 * Deterministic bubble rows for the session, top-down. Repeating the shape
 * instead of stretching it keeps the bottom three rows identical to the
 * previous three-bubble skeleton, so the skeleton-to-transcript swap does not
 * drop the rows the user was already looking at.
 */
function bubblesFor(shape: (typeof SHAPES)[number]): SkeletonBubble[] {
  return Array.from({ length: BUBBLE_COUNT }, (_, index) => {
    const layout = BUBBLE_LAYOUT[index % BUBBLE_LAYOUT.length] ?? BUBBLE_LAYOUT[0];
    const height = shape[index % shape.length] ?? shape[0];
    return {
      key: `skeleton-bubble-${index}`,
      align: layout.align,
      width: layout.width,
      tail: layout.tail,
      height,
    };
  });
}

/**
 * Mirrors MessageBubble's geometry (px-4 py-1 wrapper, rounded-2xl with an
 * asymmetric "tail" corner, self-start/self-end alignment) so the loading
 * state reads as a message list, not a spinner.
 *
 * `justify-end` matters: the real list is a FlashList with
 * `startRenderingFromBottom`, so a top-anchored placeholder would drop the
 * whole transcript from the top of the screen to the bottom on first paint.
 * `overflow-hidden` clips the rows past the region's top edge, so the skeleton
 * fills the transcript area from the composer to the header instead of
 * painting over them.
 */
export function SessionSkeletonMessages({ sessionId }: Readonly<{ sessionId?: string }>) {
  const bubbles = bubblesFor(shapeFor(sessionId ?? ''));
  return (
    <Animated.View
      exiting={FadeOut.duration(150)}
      className="flex-1 justify-end overflow-hidden pb-2"
    >
      {bubbles.map(bubble => (
        <View key={bubble.key} className={`${bubble.align} px-4 py-1`}>
          <Skeleton className={`${bubble.width} rounded-2xl ${bubble.tail} ${bubble.height}`} />
        </View>
      ))}
    </Animated.View>
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
