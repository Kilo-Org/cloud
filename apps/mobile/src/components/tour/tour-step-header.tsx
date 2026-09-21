import { type ReactNode } from 'react';
import { View } from 'react-native';

import { TOUR_HEADER_MAX_FONT_SCALE } from '@/components/tour/tour-font-scale';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Text } from '@/components/ui/text';

type TourStepHeaderProps = {
  /** Icon node for the tile; size and color are set by the step. */
  icon: ReactNode;
  /**
   * Mono-uppercase line above the title. Required so both tour steps carry it:
   * the tour's `ScreenHeader` is a bare back-button bar with no title, so the
   * label has to travel with the step's centred block — an eyebrow left in the
   * screen header sits alone at the top-left, far above the heading it names.
   */
  eyebrow: string;
  title: string;
  body: string;
};

/**
 * The opening block every tour step shares: icon tile, eyebrow, `h3` title and
 * a `text-base` body, centered and stacked.
 *
 * One component so the font-scale cap that keeps the subtitle whole above
 * the scroll fold (see `tour-font-scale`) cannot drift between steps, and
 * so the header renders into the same space no matter which path the
 * person took at the fork. The eyebrow is required and rendered here, above
 * the title, rather than in `ScreenHeader`: the tour screen passes no header
 * title, so the label would otherwise be stranded at the top-left instead of
 * centred over the heading it introduces.
 */
export function TourStepHeader({ icon, eyebrow, title, body }: Readonly<TourStepHeaderProps>) {
  return (
    <>
      <View className="h-20 w-20 items-center justify-center rounded-3xl border border-border bg-card">
        {icon}
      </View>
      <View className="items-center gap-1">
        <Eyebrow className="text-center" maxFontSizeMultiplier={TOUR_HEADER_MAX_FONT_SCALE}>
          {eyebrow}
        </Eyebrow>
        <Text
          variant="h3"
          className="text-center"
          maxFontSizeMultiplier={TOUR_HEADER_MAX_FONT_SCALE}
        >
          {title}
        </Text>
        <Text
          variant="muted"
          className="text-center text-base"
          maxFontSizeMultiplier={TOUR_HEADER_MAX_FONT_SCALE}
        >
          {body}
        </Text>
      </View>
    </>
  );
}
