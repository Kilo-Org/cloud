import { useEffect, useState } from 'react';
import { type LayoutChangeEvent, Text, type TextStyle, View, type ViewStyle } from 'react-native';

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

/**
 * Mirrors uncontrolled TextInput contents into a hidden Text node so we can
 * measure wrapped height without relying on TextInput.onContentSizeChange.
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

  function handleMeasureLayout(event: LayoutChangeEvent) {
    const textHeight = event.nativeEvent.layout.height;
    const paddedHeight = Math.ceil(textHeight + verticalPadding);
    setContentHeight(paddedHeight);
  }

  useEffect(() => {
    const nextHeight = Math.min(Math.max(contentHeight, minHeight), maxHeight);
    setHeight(current => (current === nextHeight ? current : nextHeight));
  }, [contentHeight, minHeight, maxHeight]);

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

  return { height, measureElement, reset, setText };
}

const hiddenContainer: ViewStyle = {
  position: 'absolute',
  top: -9999,
  left: 0,
  opacity: 0,
};
