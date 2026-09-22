import { useEffect, useState } from 'react';
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
  /**
   * Content height the caller's real `TextInput` reported for the same text,
   * in dp (`onContentSizeChange`), including the input's own vertical padding.
   * It is the only faithful measure of the pitch that input lays lines out at:
   * the mirror `Text` honors `lineHeight`, while the native input uses the
   * platform's own line box. Without it the cap stays raw, which is the
   * behavior of every caller that does not report one.
   */
  nativeContentHeight?: number | null;
  initialText?: string;
};

/** Plausible band for the native pitch around the requested line height. */
const NATIVE_PITCH_MIN_RATIO = 0.6;
const NATIVE_PITCH_MAX_RATIO = 1.4;

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
 * the requested line height.
 */
export function useTextHeight({
  minHeight,
  maxHeight,
  verticalPadding,
  textContentWidth,
  fontSize,
  lineHeight,
  fontScale,
  nativeContentHeight,
  initialText = '',
}: UseTextHeightOptions) {
  const [text, setMeasuredText] = useState(initialText);
  // The padded, unclamped mirror height, measured by the hidden Text node.
  const [contentHeight, setContentHeight] = useState(minHeight);
  // The clamped height published to the caller, re-clamped whenever the
  // content, the minimum, or the remaining-space cap changes.
  const [height, setHeight] = useState(minHeight);
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
  const effectiveMaxHeight =
    nativePitch !== null &&
    nativePitch >= scaledLineHeight * NATIVE_PITCH_MIN_RATIO &&
    nativePitch <= scaledLineHeight * NATIVE_PITCH_MAX_RATIO
      ? alignComposerInputHeightToLines({
          height: maxHeight,
          lineHeight: nativePitch,
          verticalPadding,
          minHeight,
        })
      : maxHeight;

  function handleMeasureLayout(event: LayoutChangeEvent) {
    const textHeight = event.nativeEvent.layout.height;
    const paddedHeight = Math.ceil(textHeight + verticalPadding);
    setContentHeight(paddedHeight);
  }

  useEffect(() => {
    const nextHeight = Math.min(Math.max(contentHeight, minHeight), effectiveMaxHeight);
    setHeight(current => (current === nextHeight ? current : nextHeight));
  }, [contentHeight, minHeight, effectiveMaxHeight]);

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

  return { height, maxHeight: effectiveMaxHeight, measureElement, reset, setText };
}

const hiddenContainer: ViewStyle = {
  position: 'absolute',
  top: -9999,
  left: 0,
  opacity: 0,
};
