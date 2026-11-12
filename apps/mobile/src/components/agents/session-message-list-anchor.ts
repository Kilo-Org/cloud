import { type ViewStyle } from 'react-native';

/**
 * How far the transcript rides up while the chrome under it grows.
 *
 * The shift applies only while the transcript's content overflows the viewport:
 * a transcript that cannot scroll has no anchoring problem to solve, and
 * shifting it would hide its first rows behind the holder with no way to
 * scroll them back. A list that can scroll keeps every hidden row reachable,
 * because the shift is a paint offset and the scroll range is untouched.
 */
export function resolveTranscriptRideUp(chromeGrowth: number, scrollable: boolean): number {
  if (!scrollable || !(chromeGrowth > 0) || !Number.isFinite(chromeGrowth)) {
    return 0;
  }
  return chromeGrowth;
}

/**
 * The frame that holds a transcript above chrome which grows.
 *
 * A transcript keeps its newest row on the bottom edge of its viewport. When
 * the chrome under it grows, the viewport shrinks in the layout pass and the
 * correction comes from the list's `onLayout`, which reaches JS one frame after
 * that pass; the scroll it issues lands later still. The transcript is then
 * painted clipped and jumps once it catches up.
 *
 * So the growth is held out of the list's own height instead: the holder takes
 * the growth back with a negative bottom margin and shifts its content up by
 * that amount, all in the same commit that grows the chrome. The list keeps the
 * viewport it had before the growth, so its rows, content height, scroll offset
 * and at-bottom verdict keep describing the same rows and no scroll command is
 * issued; the shift is a paint offset, so the newest row lands on the chrome's
 * top edge. The holder clips the strip the shift pushes above its top edge,
 * exactly as a scroll view clips the rows a scroll moves past its edge, and the
 * chrome paints over the part of the holder that lies behind it.
 */
export type TranscriptFrame = Readonly<{ holder: ViewStyle; content: ViewStyle }>;

const FILL: ViewStyle = { flex: 1 };

export function resolveTranscriptFrame(chromeGrowth: number): TranscriptFrame {
  if (!(chromeGrowth > 0)) {
    return { holder: FILL, content: FILL };
  }
  return {
    holder: { flex: 1, overflow: 'hidden', marginBottom: -chromeGrowth },
    content: { flex: 1, transform: [{ translateY: -chromeGrowth }] },
  };
}

/**
 * A composer measurement belongs to the session whose composer took it. A
 * mounted screen can switch sessions, and the previous session's growth must
 * not offset the new transcript before the new composer publishes its floor.
 */
export function composerInsetForSession(
  measurement: Readonly<{ sessionId: string; dp: number }>,
  sessionId: string
): number {
  return measurement.sessionId === sessionId ? measurement.dp : 0;
}
