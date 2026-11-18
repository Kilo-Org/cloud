import { type ReactNode } from 'react';
import { View } from 'react-native';

import { TOUR_HEADER_MAX_FONT_SCALE } from '@/components/tour/tour-font-scale';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Text } from '@/components/ui/text';

type TourStepHeaderProps = {
  /** Icon node for the tile; size and color are set by the step. */
  icon: ReactNode;
  /**
   * The label above the title. It belongs to this centred step header, not
   * the tour's screen header, which has no title to pair with it.
   */
  eyebrow: string;
  title: string;
  body: string;
};

/**
 * The opening block for a tour step: icon tile, eyebrow, title, and body.
 *
 * One component so the font-scale cap that keeps the subtitle whole above
 * the scroll fold (see `tour-font-scale`) cannot drift between steps.
 * The eyebrow is required and rendered here, above the title, rather than
 * in `ScreenHeader`, so it stays with the heading it introduces.
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
