import { type ReactNode } from 'react';
import { View } from 'react-native';

import { TOUR_HEADER_MAX_FONT_SCALE } from '@/components/tour/tour-font-scale';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Text } from '@/components/ui/text';

type TourStepHeaderProps = {
  /** Icon node for the step; size and color are set by the step. */
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
 * The opening block for a tour step: icon, eyebrow, title, and body.
 *
 * One component so the font-scale cap that keeps the subtitle whole above
 * the scroll fold (see `tour-font-scale`) cannot drift between steps.
 * The eyebrow is required and rendered here, above the title, rather than
 * in `ScreenHeader`, so it stays with the heading it introduces.
 */
export function TourStepHeader({ icon, eyebrow, title, body }: Readonly<TourStepHeaderProps>) {
  return (
    <>
      {icon}
      <View className="items-center gap-1">
        <Eyebrow className="text-center" maxFontSizeMultiplier={TOUR_HEADER_MAX_FONT_SCALE}>
          {eyebrow}
        </Eyebrow>
        <Text
          variant="heading"
          className="text-center"
          maxFontSizeMultiplier={TOUR_HEADER_MAX_FONT_SCALE}
        >
          {title}
        </Text>
        <Text
          variant="muted"
          className="text-center"
          maxFontSizeMultiplier={TOUR_HEADER_MAX_FONT_SCALE}
        >
          {body}
        </Text>
      </View>
    </>
  );
}
