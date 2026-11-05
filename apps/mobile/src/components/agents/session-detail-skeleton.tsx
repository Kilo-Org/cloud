import { Platform, View } from 'react-native';

import { BlurBar } from '@/components/ui/blur-bar';
import { useLiveFontScale } from '@/lib/font-scale/system-font-scale-context';
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
 * No exit animation: the transcript takes the placeholder's place in the same
 * commit, so an `exiting` fade paints the placeholder bubbles over the real
 * rows it gives way to, at their own positions, for the length of the fade.
 * The rows are anchored to the same bottom edge the placeholder is, so the swap
 * lands in the same place and only the real messages show.
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
    <View className="flex-1 justify-end overflow-hidden px-4 pb-2">
      <Skeleton className={`my-1 w-3/4 shrink self-start rounded-2xl rounded-tl-sm ${first}`} />
      <Skeleton className={`my-1 w-1/2 shrink self-end rounded-2xl rounded-tr-sm ${second}`} />
      <Skeleton className={`my-1 w-2/3 shrink self-start rounded-2xl rounded-tl-sm ${third}`} />
    </View>
  );
}

/**
 * Holds the read-only footer's place while the session's transcript and
 * transport are still resolving. Until the transport answers, neither the route
 * nor the screen knows whether the bottom slot ends in the composer or in the
 * read-only footer, so both loading states reserve the footer's area — a line
 * and a button bar in the footer's own container — instead of offering a
 * composer that a read-only session will not have. The footer then lands on its
 * own geometry and the transcript never moves under it.
 *
 * The bars take `bg-muted-soft`: the footer paints its own `bg-secondary`, and
 * the placeholder fill matches that surface in the light palette, so
 * default-tone bars on this fill paint nothing and the reserved area read as a
 * blank tinted block. The line is the footer note's `text-sm` line box and the
 * bar its `action` button's 48pt floor.
 */
export function SessionReadOnlyFooterPlaceholder() {
  return (
    <View className="gap-3 border-t border-border bg-secondary px-4 py-3">
      <Skeleton className="mx-auto h-[17.5px] w-40 bg-muted-soft" />
      <Skeleton className="h-[48px] bg-muted-soft" />
    </View>
  );
}

/** ChatComposer's input line box, vertical padding and field border, in points. */
const COMPOSER_FIELD_LINE = 20;
const COMPOSER_FIELD_PADDING = 24;
const COMPOSER_FIELD_BORDER = 2;

/**
 * Holds the composer's place while the session loads: the route paints it only
 * once its metadata names a cloud-agent session, and the session screen paints
 * it while an open resolved to a writable kind still has nothing to show. An
 * unresolved open reserves the read-only footer instead, because the composer
 * is the one shape that kind may never get. Without it the composer pops in on
 * resolve and shoves the transcript up by its own height.
 *
 * Geometry follows ChatComposer's input row: a BlurBar wrapping the row's
 * `p-2.5 px-3`, the field's own box at `rounded-[20px]` and the two trailing
 * controls at `CONTROL_HIT_TARGET`'s 48 pt on Android and 44 pt on iOS — `ms-3`
 * is the row's COMPOSER_CONTROL_GAP_CLASS, repeated here because the row module
 * owns it.
 *
 * Sizes are written in points, not scale steps: this app's rem is 14 pt, so
 * `h-11` paints 38.5 pt and would leave the slot 6 pt short of the composer that
 * replaces it. The field keeps the composer's own height rule — its line's box
 * times the live system font scale, plus the input's vertical padding and the
 * field's own 1 pt border on each side — so the box neither clips its row nor
 * leaves a gap at any text size, and it follows a text-size change without a
 * remount, the way the composer does.
 */
export function SessionComposerSkeleton() {
  const fontScale = useLiveFontScale();
  const control = Platform.OS === 'android' ? 'h-[48px] w-[48px]' : 'h-[44px] w-[44px]';
  return (
    <BlurBar>
      <View className="p-2.5 px-3">
        <View className="flex-row items-center">
          <View
            className="flex-1 justify-center"
            style={{
              height:
                COMPOSER_FIELD_LINE * fontScale + COMPOSER_FIELD_PADDING + COMPOSER_FIELD_BORDER,
            }}
          >
            <Skeleton className="h-full w-full rounded-[20px]" />
          </View>
          <Skeleton className={`ms-3 rounded-full ${control}`} />
          <Skeleton className={`ms-3 rounded-full ${control}`} />
        </View>
      </View>
    </BlurBar>
  );
}
