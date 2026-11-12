/**
 * How far the transcript rides up while the chrome under it grows.
 *
 * A transcript keeps its newest row on the bottom edge of its viewport. When
 * the chrome under it grows, the viewport shrinks in the layout pass and the
 * correction comes from the list's `onLayout`, which reaches JS one frame after
 * that pass; the scroll it issues lands later still. The transcript is then
 * painted clipped and jumps once it catches up.
 *
 * So the transcript's content is shifted up by the growth itself, in the same
 * commit that grows the chrome: the rows keep their order and their offsets, no
 * scroll command is issued, and the newest row stays on the chrome's top edge.
 * The shift is a paint offset on the list's content, which a scroll view clips
 * exactly as it clips the rows a scroll moves past its edge.
 *
 * The shift applies only while the transcript is anchored at its bottom and its
 * content overflows the viewport. The rows the shift hides are the ones a
 * scroll to the same position would hide, and the list keeps enough scroll range
 * to bring them back; a transcript that cannot scroll has no anchoring problem
 * to solve, so it never shifts.
 */
export function resolveTranscriptRideUp(chromeGrowth: number, anchoredAtBottom: boolean): number {
  if (!anchoredAtBottom || !(chromeGrowth > 0) || !Number.isFinite(chromeGrowth)) {
    return 0;
  }
  return chromeGrowth;
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
