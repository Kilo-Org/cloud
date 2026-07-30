/**
 * Pure height reducers for the agents chat composer TextInput.
 *
 * RN multiline TextInput `contentSize.height` already includes the
 * `paddingVertical` inset, so style height is a ceil+clamp of that value.
 * Staleness rules:
 * - empty draft always resolves to minHeight (guards after-clear stale events)
 * - voice-draft ordering can fire content-size while textRef still holds the
 *   old empty draft; `resolveComposerHeightOnTextChange` repairs empty→non-empty
 *   using the last measured content height
 */

export function clampComposerInputHeight(
  contentHeight: number,
  { minHeight, maxHeight }: { minHeight: number; maxHeight: number }
): number {
  return Math.min(Math.max(Math.ceil(contentHeight), minHeight), maxHeight);
}

export function resolveComposerInputHeight({
  draftLength,
  contentHeight,
  minHeight,
  maxHeight,
}: {
  draftLength: number;
  contentHeight: number;
  minHeight: number;
  maxHeight: number;
}): number {
  if (draftLength === 0) {
    return minHeight;
  }
  return clampComposerInputHeight(contentHeight, { minHeight, maxHeight });
}

/**
 * Optimistic height after a JS text change.
 * - empty next draft → minHeight
 * - empty→non-empty with a prior content measurement → clamp that measurement
 *   (voice-ordering repair when setNativeProps races ahead of onChangeText)
 * - otherwise null (leave height to the next native onContentSizeChange)
 */
export function resolveComposerHeightOnTextChange({
  previousDraftLength,
  nextDraftLength,
  lastContentHeight,
  minHeight,
  maxHeight,
}: {
  previousDraftLength: number;
  nextDraftLength: number;
  lastContentHeight: number | null;
  minHeight: number;
  maxHeight: number;
}): number | null {
  if (nextDraftLength === 0) {
    return minHeight;
  }
  if (previousDraftLength === 0 && nextDraftLength > 0 && lastContentHeight !== null) {
    return clampComposerInputHeight(lastContentHeight, { minHeight, maxHeight });
  }
  return null;
}

export function shouldEnableComposerInputScroll(height: number, maxHeight: number): boolean {
  return height >= maxHeight;
}
