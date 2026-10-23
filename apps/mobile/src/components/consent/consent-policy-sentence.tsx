import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { LEGAL_LINK_BOX_CLASS } from '@/lib/a11y/tap-target';
import { cn } from '@/lib/utils';

type ConsentPolicySentenceProps = {
  /** The sentence's lead-in copy, already translated, ending where the link starts. */
  readonly prefix: string;
  /** The link's copy, already translated. */
  readonly linkLabel: string;
  readonly onOpenPolicy: () => void;
  /** Caps the sentence's text size where its footer height is bounded. */
  readonly maxFontSizeMultiplier?: number;
  /** The sentence's own placement, e.g. the gap that separates it from the content above. */
  readonly className?: string;
};

/**
 * The sentence that names the privacy policy at the end of a consent surface
 * ("Your data is handled per the Privacy Policy.").
 *
 * The sentence is a row of nodes rather than one `Text` with a nested handler,
 * because a nested link's press region is its glyphs: the whole target would be
 * the 14dp `text-xs` line. As a node of its own the link carries
 * `{@link LEGAL_LINK_BOX_CLASS}`, a real 48dp target the control-size audit can
 * read, laid out layout-neutrally so the sentence keeps its line and the glyphs
 * keep their position. The prefix can wrap, so the row wraps with it; the link
 * and the closing period move together.
 */
export function ConsentPolicySentence({
  prefix,
  linkLabel,
  onOpenPolicy,
  maxFontSizeMultiplier,
  className,
}: ConsentPolicySentenceProps) {
  return (
    <View className={cn('flex-row flex-wrap items-center', className)}>
      <Text className="text-xs text-muted-foreground" maxFontSizeMultiplier={maxFontSizeMultiplier}>
        {prefix}{' '}
      </Text>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={linkLabel}
        className={cn(LEGAL_LINK_BOX_CLASS, 'active:opacity-70')}
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
