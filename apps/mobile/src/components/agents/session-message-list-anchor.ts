import { type ViewStyle } from 'react-native';

/**
 * The frame that holds a transcript above chrome which grows.
 *
 * A transcript keeps its newest row on the bottom edge of its viewport. When
 * the chrome under it grows, the viewport shrinks in the layout pass and the
 * correction comes from the list's `onLayout`, which reaches JS one frame after
 * that pass; the scroll it issues lands later still. The transcript is then
 * painted clipped and jumps once it catches up.
 *
 * So the growth is reserved in the layout instead: the transcript keeps the
 * height it had before the growth and rides up, so its bottom edge stays on the
 * chrome's top edge — `top` and `bottom` together give the frame exactly that
 * previous height. Nothing inside the transcript changes, so its viewport,
 * content height, scroll offset and at-bottom verdict keep describing the same
 * rows, and no scroll command is issued at all.
 *
 * The frame is taller than its holder by the inset, so the holder clips the
 * strip the ride pushes above its top edge. That strip holds the padding and
 * the start of the oldest rows: at the tail of a transcript that overflows the
 * region it lies far above the viewport, and it is the first rows only when the
 * list is scrolled to its very top.
 */
export type TranscriptFrame = Readonly<{ holder: ViewStyle; content: ViewStyle }>;

const FILL: ViewStyle = { flex: 1 };

export function resolveTranscriptFrame(chromeGrowth: number): TranscriptFrame {
  if (!(chromeGrowth > 0)) {
    return { holder: FILL, content: FILL };
  }
  return {
    holder: { flex: 1, overflow: 'hidden' },
    content: { position: 'absolute', left: 0, right: 0, bottom: 0, top: -chromeGrowth },
  };
}

/**
 * A composer measurement belongs to the session whose composer took it. A
 * mounted screen can switch sessions, and the next session's composer mounts on
 * its one-line floor without publishing a change, so the previous session's
 * growth must not offset the new transcript.
 */
export function composerInsetForSession(
  measurement: Readonly<{ sessionId: string; dp: number }>,
  sessionId: string
): number {
  return measurement.sessionId === sessionId ? measurement.dp : 0;
}
