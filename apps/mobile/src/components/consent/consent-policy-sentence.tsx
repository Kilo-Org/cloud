import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import {
  INLINE_LINK_BOX_CLASS,
  INLINE_LINK_LINE_GAP_CLASS,
  INLINE_LINK_VERTICAL_HIT_SLOP_DP,
} from '@/lib/a11y/tap-target';
import { cn } from '@/lib/utils';

type ConsentPolicySentenceProps = {
  /** The sentence's lead-in copy, already translated, ending where the link starts. */
  readonly prefix: string;
  /** The link's copy, already translated. */
  readonly linkLabel: string;
  readonly onOpenPolicy: () => void;
  /** Caps the sentence's text size where its footer height is bounded. */
  readonly maxFontSizeMultiplier?: number;
};

/**
 * The sentence that names the privacy policy at the end of a consent surface
 * ("Your data is handled per the Privacy Policy.").
 *
 * The sentence is a row of nodes rather than one `Text` with a nested handler,
 * because a nested link's press region is its glyphs: the whole target would be
 * the 14dp `text-xs` line. As a node of its own the link carries
 * `{@link INLINE_LINK_BOX_CLASS}`, a real 28dp box the control-size audit can
 * read, plus the shared 8dp vertical slop for `DESIGN.md:364`'s 44pt region.
 * The prefix can wrap, so the row wraps with it; the link and the closing period
 * move together, and the row's wrapped lines keep
 * `{@link INLINE_LINK_LINE_GAP_CLASS}` so the link box's 7dp overflow past its
 * own line never reaches the prose on the line above or below it.
 */
export function ConsentPolicySentence({
  prefix,
  linkLabel,
  onOpenPolicy,
  maxFontSizeMultiplier,
}: ConsentPolicySentenceProps) {
  return (
    <View className={cn('flex-row flex-wrap items-center', INLINE_LINK_LINE_GAP_CLASS)}>
      <Text className="text-xs text-muted-foreground" maxFontSizeMultiplier={maxFontSizeMultiplier}>
        {prefix}{' '}
      </Text>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={linkLabel}
        hitSlop={{
          top: INLINE_LINK_VERTICAL_HIT_SLOP_DP,
          bottom: INLINE_LINK_VERTICAL_HIT_SLOP_DP,
        }}
        className={cn(INLINE_LINK_BOX_CLASS, 'active:opacity-70')}
        onPress={onOpenPolicy}
      >
        <Text
          className="text-xs text-primary underline"
          maxFontSizeMultiplier={maxFontSizeMultiplier}
        >
          {linkLabel}
        </Text>
      </Pressable>
      <Text className="text-xs text-muted-foreground" maxFontSizeMultiplier={maxFontSizeMultiplier}>
        .
      </Text>
    </View>
  );
}
