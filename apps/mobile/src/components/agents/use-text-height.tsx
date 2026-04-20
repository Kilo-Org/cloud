import { useState } from 'react';
import { type LayoutChangeEvent, Text, type TextStyle, View, type ViewStyle } from 'react-native';

type UseTextHeightOptions = {
  minHeight: number;
  maxHeight: number;
  verticalPadding: number;
  textContentWidth: number;
  fontSize: number;
  lineHeight: number;
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
}: UseTextHeightOptions) {
  const [text, setMeasuredText] = useState('');
  const [height, setHeight] = useState(minHeight);
  const measuredText = text.length === 0 || text.endsWith('\n') ? `${text} ` : text;
  const measurementWidth = Math.max(textContentWidth, 0);

  function handleMeasureLayout(event: LayoutChangeEvent) {
    const textHeight = event.nativeEvent.layout.height;
    const paddedHeight = Math.ceil(textHeight + verticalPadding);
    const nextHeight = Math.min(Math.max(paddedHeight, minHeight), maxHeight);
    setHeight(current => (current === nextHeight ? current : nextHeight));
  }

  function setText(nextText: string) {
    setMeasuredText(nextText);
    if (nextText.length === 0) {
      setHeight(minHeight);
    }
  }

  function reset() {
    setMeasuredText('');
    setHeight(minHeight);
  }

  const textStyle: TextStyle = {
    fontSize,
    includeFontPadding: false,
    lineHeight,
    width: measurementWidth,
  };

  const measureElement =
    measurementWidth > 0 ? (
      <View style={hiddenContainer} pointerEvents="none">
        <Text style={textStyle} onLayout={handleMeasureLayout}>
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
