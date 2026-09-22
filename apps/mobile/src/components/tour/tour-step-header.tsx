import { type ReactNode } from 'react';
import { View } from 'react-native';

import { TOUR_HEADER_MAX_FONT_SCALE } from '@/components/tour/tour-font-scale';
import { Text } from '@/components/ui/text';

type TourStepHeaderProps = {
  /** Icon node for the tile; size and color are set by the step. */
  icon: ReactNode;
  title: string;
  body: string;
};

/**
 * The opening block every tour step shares: icon tile, `h3` title and a
 * `text-base` body, centered and stacked.
 *
 * One component so the font-scale cap that keeps the subtitle whole above
 * the scroll fold (see `tour-font-scale`) cannot drift between steps, and
 * so the header renders into the same space no matter which path the
 * person took at the fork.
 */
export function TourStepHeader({ icon, title, body }: Readonly<TourStepHeaderProps>) {
  return (
    <>
      <View className="h-20 w-20 items-center justify-center rounded-3xl border border-border bg-card">
        {icon}
      </View>
      <View className="items-center gap-1">
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
