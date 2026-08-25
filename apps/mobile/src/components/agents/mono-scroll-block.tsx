import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { type LayoutChangeEvent, View } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import { useTranslation } from 'react-i18next';

import { SelectableText } from '@/components/ui/selectable-text';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

import { useTranscriptTextSelectable } from './bubble-text-selection-context';
import {
  MONO_SCROLL_VIEW_PROPS,
  type MonoScrollHeightPin,
  type MonoScrollTextMode,
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
  /** True for the transcript caller: keeps the `Text` path byte-identical there. */
  inTranscript?: boolean;
};

/**
 * Sheet-level mono display mode and presence tracker, provided by the tool
 * detail sheet. `null` outside the sheet (transcript/preparation blocks).
 */
type MonoScrollSheetContextValue = {
  mode: MonoScrollTextMode;
  /** Registers a mounted mono block; returns the unregister. */
  track: () => () => void;
};

const MonoScrollSheetContext = createContext<MonoScrollSheetContextValue | null>(null);
export const MonoScrollSheetProvider = MonoScrollSheetContext.Provider;

/** Sheet mono mode/presence for any block that joins the mono contract. */
export function useMonoScrollSheet(): MonoScrollSheetContextValue | null {
  return useContext(MonoScrollSheetContext);
}

/**
 * Monospace block for tool-card / preparation output.
 *
 * Two display modes:
 * - `scroll` (default outside the sheet): the RNGH horizontal ScrollView with
 *   intrinsic-width text and a measured height pin (delivery notes below).
 * - `wrap` (sheet default): wrapped text with no ScrollView, no `onLayout`
 *   measurement, and no height pin — the sheet's own vertical ScrollView is the
 *   only scroller, so no nested horizontal gesture exists. Selection keeps the
 *   scroll-branch split: `SelectableText` outside transcript, plain `Text`
 *   inside transcript.
 *
 * The mode comes from `MonoScrollSheetContext`, provided by `PartDetailSheet`.
 * Each mounted block also registers presence through that context so the sheet
 * can render its mode control exactly when mono content exists.
 *
 * Nested-scroll delivery (device-proven): RN 0.83 Fabric does not hand
 * horizontal pans to a stock RN ScrollView nested inside the session FlashList
 * — content is wide enough, but the inner scroller never receives the pan.
 * This block uses `ScrollView` from `react-native-gesture-handler` with
 * `activeOffsetX` / `failOffsetY` so horizontal pans activate the block and
 * vertical pans fail over to the conversation list (same hazard family as
 * nested scrolls in the markdown renderer).
 *
 * Intrinsic width: mono Text keeps `shrink-0 self-start` so content lays out
 * at its natural width inside the horizontal scroller.
 *
 * Height pin: pin ScrollView height from the content's onLayout measurement so
 * RN 0.83 Fabric cannot inflate a horizontal ScrollView inside a width-
 * constrained parent (~10× spurious height). The pin is keyed to displayText
 * so a taller payload remeasures instead of clipping into a stale height.
 */
export function MonoScrollBlock({
  content,
  maxLength,
  textClassName,
  containerClassName,
  inTranscript = false,
}: Readonly<MonoScrollBlockProps>) {
  const textSelectable = useTranscriptTextSelectable();
  const sheet = useMonoScrollSheet();
  const { t } = useTranslation();
  const textMode = sheet?.mode ?? 'scroll';
  const track = sheet?.track;
  const { displayText, isTruncated } = prepareMonoScrollContent(content, maxLength);
  const [heightPin, setHeightPin] = useState<MonoScrollHeightPin | undefined>(undefined);
  const contentHeight = resolveMonoScrollPinnedHeight(heightPin, displayText);

  // Registers this block's presence exactly once per mount; the cleanup is the
  // unregister. The effect only re-runs when `track` identity changes, which
  // the sheet keeps stable, so mode flips never re-register.
  useEffect(() => track?.(), [track]);

  const handleContentLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const measured = event.nativeEvent.layout.height;
      setHeightPin(prev => nextMonoScrollHeightPin(prev, displayText, measured));
    },
    [displayText]
  );

  if (textMode === 'wrap') {
    const wrapContentClasses = 'font-mono text-xs leading-4';
    return (
      <View className={containerClassName}>
        {inTranscript ? (
          <Text selectable={textSelectable} className={cn(wrapContentClasses, textClassName)}>
            {displayText}
          </Text>
        ) : (
          <SelectableText className={cn(wrapContentClasses, textClassName)}>
            {displayText}
          </SelectableText>
        )}
        {isTruncated ? (
          <Text
            accessibilityLabel={t('monoScrollBlock.contentTruncated')}
            className="mt-1 text-xs text-muted-foreground"
          >
            {t('monoScrollBlock.truncated')}
          </Text>
        ) : null}
      </View>
    );
  }
  const contentClasses = 'shrink-0 self-start font-mono text-xs leading-4';

  return (
    <View className={containerClassName}>
      <ScrollView
        {...MONO_SCROLL_VIEW_PROPS}
        // Explicit height from measured content — see component doc.
        // eslint-disable-next-line react-native/no-inline-styles -- measured height cannot be a Tailwind class
        style={contentHeight === undefined ? undefined : { height: contentHeight }}
      >
        {inTranscript ? (
          <Text
            selectable={textSelectable}
            onLayout={handleContentLayout}
            className={cn(contentClasses, textClassName)}
          >
            {displayText}
          </Text>
        ) : (
          <SelectableText
            onLayout={handleContentLayout}
            className={cn(contentClasses, textClassName)}
          >
            {displayText}
          </SelectableText>
        )}
      </ScrollView>
      {isTruncated ? (
        <Text
          accessibilityLabel={t('monoScrollBlock.contentTruncated')}
          className="mt-1 text-xs text-muted-foreground"
        >
          {t('monoScrollBlock.truncated')}
        </Text>
      ) : null}
    </View>
  );
}
