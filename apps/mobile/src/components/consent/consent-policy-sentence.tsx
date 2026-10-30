import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { LEGAL_LINK_BOX_CLASS, LEGAL_LINK_SENTENCE_BOX_CLASS } from '@/lib/a11y/tap-target';
import { cn } from '@/lib/utils';

type ConsentPolicySentenceProps = {
  /** The sentence's lead-in copy, already translated, ending where the link starts. */
  readonly prefix: string;
  /** The link's copy, already translated. */
  readonly linkLabel: string;
  readonly onOpenPolicy: () => void;
  /** Caps the sentence's text size where its footer height is bounded. */
  readonly maxFontSizeMultiplier?: number;
  /**
   * Reserves the link's whole 48dp target as the row's height, instead of
   * cancelling the box's vertical overflow.
   *
   * The cancelled box keeps the sentence on its 14dp line, but the box itself
   * still reaches 17dp above and below that line. That is invisible inside a
   * scroll body, where the overflow only lands on prose, and wrong where the
   * sentence starts a container: the consent card's pinned footer pads its top
   * by `pt-3` (10.5dp), so the box's top ~6.5dp sat over the scroll region
   * above it. Pass this wherever the sentence is a container's first child.
   */
  readonly reserveTargetHeight?: boolean;
};

/**
 * The sentence that names the privacy policy at the end of a consent surface
 * ("Your data is handled per the Privacy Policy.").
 *
 * The sentence is a row of nodes rather than one `Text` with a nested handler,
 * because a nested link's press region is its glyphs: the whole target would be
 * the 14dp `text-xs` line. As a node of its own the link carries a real 48dp
 * target the control-size audit can read, whose overflow past the line is
 * cancelled so the sentence keeps its line and the glyphs keep their position,
 * or — for a caller that passes `reserveTargetHeight` — takes that height into
 * the row so nothing reaches past it. The prefix can wrap, so the row wraps
 * with it; the link and the closing period move together.
 */
export function ConsentPolicySentence({
  prefix,
  linkLabel,
  onOpenPolicy,
  maxFontSizeMultiplier,
  reserveTargetHeight = false,
}: ConsentPolicySentenceProps) {
  const targetClass = reserveTargetHeight ? LEGAL_LINK_BOX_CLASS : LEGAL_LINK_SENTENCE_BOX_CLASS;

  return (
    <View className="flex-row flex-wrap items-center">
      <Text className="text-xs text-muted-foreground" maxFontSizeMultiplier={maxFontSizeMultiplier}>
        {prefix}{' '}
      </Text>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={linkLabel}
        className={cn(targetClass, 'active:opacity-70')}
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
