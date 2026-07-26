import { useCallback, useState } from 'react';
import { type LayoutChangeEvent, ScrollView, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

import {
  MONO_SCROLL_VIEW_PROPS,
  type MonoScrollHeightPin,
  nextMonoScrollHeightPin,
  prepareMonoScrollContent,
  resolveMonoScrollPinnedHeight,
} from './mono-scroll-block-model';

type MonoScrollBlockProps = {
  content: string;
  /** When set, content longer than this is sliced and a "Truncated" marker is shown. */
  maxLength?: number;
  /** Merged onto the mono Text (colors, leading). Base mono sizing is applied. */
  textClassName?: string;
  /** Optional chrome around the scroller (e.g. rounded bg on preparation output). */
  containerClassName?: string;
};

/**
 * Horizontally scrollable monospace block for tool-card / preparation output.
 *
 * C-b delivery: mono Text uses `shrink-0` so Yoga does not compress it to the
 * card width (which made the ScrollView content width equal the viewport and
 * left line tails unreachable). Scroll props hand horizontal pans to this
 * view and vertical pans to the parent list.
 *
 * D10 height: pin ScrollView height from the content's onLayout measurement so
 * RN 0.83 Fabric cannot inflate a horizontal ScrollView inside a width-
 * constrained parent (~10× spurious height). The pin is keyed to displayText
 * so a taller payload remeasures instead of clipping into a stale height.
 */
export function MonoScrollBlock({
  content,
  maxLength,
  textClassName,
  containerClassName,
}: Readonly<MonoScrollBlockProps>) {
  const { displayText, isTruncated } = prepareMonoScrollContent(content, maxLength);
  const [heightPin, setHeightPin] = useState<MonoScrollHeightPin | undefined>(undefined);
  const contentHeight = resolveMonoScrollPinnedHeight(heightPin, displayText);

  const handleContentLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const measured = event.nativeEvent.layout.height;
      setHeightPin(prev => nextMonoScrollHeightPin(prev, displayText, measured));
    },
    [displayText]
  );

  return (
    <View className={containerClassName}>
      <ScrollView
        {...MONO_SCROLL_VIEW_PROPS}
        // Explicit height from measured content — see D10 / component doc.
        // eslint-disable-next-line react-native/no-inline-styles -- measured height cannot be a Tailwind class
        style={contentHeight === undefined ? undefined : { height: contentHeight }}
      >
        <Text
          selectable
          onLayout={handleContentLayout}
          className={cn('shrink-0 font-mono text-xs leading-4', textClassName)}
        >
          {displayText}
        </Text>
      </ScrollView>
      {isTruncated ? (
        <Text accessibilityLabel="Content truncated" className="mt-1 text-xs text-muted-foreground">
          Truncated
        </Text>
      ) : null}
    </View>
  );
}
