import { useRef, useState } from 'react';
import { type LayoutChangeEvent, Text, type TextStyle, View, type ViewStyle } from 'react-native';

import { alignComposerInputHeightToLines } from '@/components/agents/chat-composer-input-height';

type UseTextHeightOptions = {
  minHeight: number;
  maxHeight: number;
  verticalPadding: number;
  textContentWidth: number;
  fontSize: number;
  lineHeight: number;
  /**
   * System Dynamic Type scale. When set, the caller pre-scales `fontSize` and
   * `lineHeight` here and native scaling is disabled on the measure node, so
   * the scale applies exactly once. When omitted, the base sizes are rendered
   * and native scaling applies (the kilo-chat message input path).
   */
  fontScale?: number;
  initialText?: string;
};

/** Plausible band for the native pitch around the requested line height. */
const NATIVE_PITCH_MIN_RATIO = 0.6;
const NATIVE_PITCH_MAX_RATIO = 1.4;

/**
 * How far, in dp, the line pitch a native content-height report implies may
 * move before it is worth a state update. The report exists only to estimate
 * the pitch the real input lays lines out at, and that pitch does not move when
 * the draft grows a line — its content height and its line count grow together.
 * Half a point is well below the pitch change that can move the snapped cap to
 * another whole line (`floor(cap / pitch)` needs about half a point at this
 * line height), so dropping a smaller move loses nothing.
 */
const NATIVE_PITCH_STABLE_STEP = 0.5;

/**
 * Mirrors uncontrolled TextInput contents into a hidden Text node so we can
 * measure wrapped height without relying on TextInput.onContentSizeChange.
 *
 * The published cap is snapped down to a whole number of the lines the native
 * input actually renders (see `alignComposerInputHeightToLines`). A capped
 * multiline input scrolls to the caret by `contentHeight - viewHeight`; if that
 * difference is not a whole number of rendered lines, the first visible line is
 * painted cut against the input's top edge. Android's `TextInput` lays lines
 * out at the font's own line box rather than the requested `lineHeight` — on
 * this composer's 16dp Roboto at 420dpi the real input reports 49px per line,
 * 18.67dp against a requested 20dp — so the snap uses the pitch measured from
 * the real input's reported content height over the mirror's line count, not
 * the requested line height. The floor is snapped to that same pitch, so a cap
 * that lands on the minimum stays a whole number of native lines too.
 *
 * The caller pushes that report in with `setNativeContentHeight`, which keeps
 * the height out of the caller's own state: a report only records a new height
 * when it moves the pitch the snap uses, so a draft that grows a line — the
 * content height and the line count grow together, so the pitch stays put —
 * never re-renders the caller.
 */
export function useTextHeight({
  minHeight,
  maxHeight,
  verticalPadding,
  textContentWidth,
  fontSize,
  lineHeight,
  fontScale,
  initialText = '',
}: UseTextHeightOptions) {
  const [text, setMeasuredText] = useState(initialText);
  // The padded, unclamped mirror height, measured by the hidden Text node.
  const [contentHeight, setContentHeight] = useState(minHeight);
  // The content height the caller's real `TextInput` last reported through
  // `setNativeContentHeight`, in dp, including the input's own vertical
  // padding. It is the only faithful measure of the pitch that input lays lines
  // out at: the mirror `Text` honors `lineHeight`, while the native input uses
  // the platform's own line box.
  const [nativeContentHeight, setNativeContentHeightInState] = useState<number | null>(null);
  // The pitch the last recorded report implied; a report that keeps the pitch
  // within `NATIVE_PITCH_STABLE_STEP` of it is dropped without a state update:
  // the report arrives on every native content-size event, and scheduling one
  // per report re-rendered the caller's whole composer and its input on each
  // one.
  const acceptedPitchRef = useRef<number | null>(null);
  const measuredText = text.length === 0 || text.endsWith('\n') ? `${text} ` : text;
  const measurementWidth = Math.max(textContentWidth, 0);
  // Pre-scale only when the caller opted in (the agent composers). The
  // kilo-chat message input omits `fontScale` and relies on native scaling.
  const scaledFontSize = fontScale == null ? fontSize : fontSize * fontScale;
  const scaledLineHeight = fontScale == null ? lineHeight : lineHeight * fontScale;
  // Disable native scaling only when the caller pre-scaled, so the scale is
  // applied exactly once instead of twice.
  const maxFontSizeMultiplier = fontScale == null ? undefined : 1;
  // The mirror and the native input wrap the same text at the same width into
  // the same number of lines, so the input's rendered pitch is its reported
  // content height (minus the padding it carries) over the mirror's line
  // count. The count grows with the draft, so the estimate sharpens exactly
  // where it matters: the cap below only bites once the content is tall enough
  // to scroll, and by then the report is several lines deep.
  const mirrorLineCount = Math.max(
    1,
    Math.round((contentHeight - verticalPadding) / scaledLineHeight)
  );
  const nativePitch =
    nativeContentHeight != null && nativeContentHeight > verticalPadding
      ? (nativeContentHeight - verticalPadding) / mirrorLineCount
      : null;
  /**
   * The caller's `onContentSizeChange` report. Records the height only when the
   * pitch it implies (at the mirror's current line count) has moved by at least
   * `NATIVE_PITCH_STABLE_STEP`; a report that keeps the pitch where it was does
   * not schedule an update at all, so the caller does not re-render its input
   * on every native content-size event.
   */
  function setNativeContentHeight(nextContentHeight: number): void {
    const nextPitch =
      nextContentHeight > verticalPadding && mirrorLineCount > 0
        ? (nextContentHeight - verticalPadding) / mirrorLineCount
        : null;
    const acceptedPitch = acceptedPitchRef.current;
    if (
      nextPitch !== null &&
      acceptedPitch !== null &&
      Math.abs(nextPitch - acceptedPitch) < NATIVE_PITCH_STABLE_STEP
    ) {
      return;
    }
    acceptedPitchRef.current = nextPitch;
    setNativeContentHeightInState(nextContentHeight);
  }
  // `minHeight` is the caller's one-line floor in the requested line box
  // (`scaledLineHeight + padding`), while the snap floors to the pitch the
  // native input really renders. A cap that lands on the minimum would publish
  // that unaligned minimum and clip the first visible line again, so the floor
  // is re-expressed in whole native lines. It is clamped to the cap, which
  // keeps the snapped height from ever exceeding the space the composer has.
  const alignedMinHeight =
    nativePitch !== null
      ? Math.min(
          verticalPadding +
            Math.max(1, Math.floor((minHeight - verticalPadding) / nativePitch)) * nativePitch,
          maxHeight
        )
      : minHeight;
  const effectiveMaxHeight =
    nativePitch !== null &&
    nativePitch >= scaledLineHeight * NATIVE_PITCH_MIN_RATIO &&
    nativePitch <= scaledLineHeight * NATIVE_PITCH_MAX_RATIO
      ? alignComposerInputHeightToLines({
          height: maxHeight,
          lineHeight: nativePitch,
          verticalPadding,
          minHeight: alignedMinHeight,
        })
      : maxHeight;

  function handleMeasureLayout(event: LayoutChangeEvent) {
    const textHeight = event.nativeEvent.layout.height;
    const paddedHeight = Math.ceil(textHeight + verticalPadding);
    setContentHeight(paddedHeight);
  }

  // The clamped height this hook publishes: a pure function of the measured
  // content, the caller's floor, and the remaining-space cap. It is derived in
  // render instead of held in state: a state copy re-clamped in an effect
  // published the previous height together with the new cap — two notifications
  // of the caller, and so two commits, for one change.
  const height = Math.min(Math.max(contentHeight, minHeight), effectiveMaxHeight);

  function setText(nextText: string) {
    setMeasuredText(nextText);
    if (nextText.length === 0) {
      setContentHeight(minHeight);
    }
  }

  function reset() {
    setMeasuredText('');
    setContentHeight(minHeight);
  }

  const textStyle: TextStyle = {
    fontSize: scaledFontSize,
    includeFontPadding: false,
    lineHeight: scaledLineHeight,
    width: measurementWidth,
  };

  const measureElement =
    measurementWidth > 0 ? (
      <View style={hiddenContainer} pointerEvents="none">
        <Text
          style={textStyle}
          onLayout={handleMeasureLayout}
          maxFontSizeMultiplier={maxFontSizeMultiplier}
        >
          {measuredText}
        </Text>
      </View>
    ) : null;

  return {
    height,
    maxHeight: effectiveMaxHeight,
    measureElement,
    reset,
    setNativeContentHeight,
    setText,
  };
}

const hiddenContainer: ViewStyle = {
  position: 'absolute',
  top: -9999,
  left: 0,
  opacity: 0,
};
