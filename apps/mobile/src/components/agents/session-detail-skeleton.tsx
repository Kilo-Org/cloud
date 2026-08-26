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
 */
export function SessionSkeletonMessages({ sessionId }: Readonly<{ sessionId?: string }>) {
  const [first, second, third] = shapeFor(sessionId ?? '');
  return (
    <Animated.View exiting={FadeOut.duration(150)} className="flex-1 justify-end pb-2">
      <View className="items-start px-4 py-1">
        <Skeleton className={`w-3/4 rounded-2xl rounded-tl-sm ${first}`} />
      </View>
      <View className="items-end px-4 py-1">
        <Skeleton className={`w-1/2 rounded-2xl rounded-tr-sm ${second}`} />
      </View>
      <View className="items-start px-4 py-1">
        <Skeleton className={`w-2/3 rounded-2xl rounded-tl-sm ${third}`} />
      </View>
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
