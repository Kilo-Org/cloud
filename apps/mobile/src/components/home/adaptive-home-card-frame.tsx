import { createContext, type ReactNode, useContext } from 'react';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { DENSE_ROW_FRAME_CLASS } from '@/lib/a11y/tap-target';
import { cn } from '@/lib/utils';

type AdaptiveHomeCardFrameProps = {
  live: ReactNode;
  briefing?: ReactNode;
  showBriefing: boolean;
};

/**
 * Whether the card layer around a node is only reserving the frame's height.
 * The frame draws the live card and the briefing in the same pixels, so the
 * layer that is not drawn holds no controls: their press targets would share
 * every pixel of the frame, and a tap there would be ambiguous as soon as the
 * hidden layer stops being fully transparent (finding home-card-layer-overlap).
 */
const ReservedCardLayerContext = createContext(false);

/** True inside the frame layer that only reserves height for its card. */
export function useReservedHomeCardLayer(): boolean {
  return useContext(ReservedCardLayerContext);
}

type CardControlProps = Omit<React.ComponentProps<typeof Pressable>, 'className' | 'children'> & {
  className?: string;
  children?: ReactNode;
};

/** A press-state variant: the one class family that turns a view into a press target. */
const PRESS_FEEDBACK_VARIANT = /\bactive:\S+/g;

/**
 * The press target every control of these two cards renders, with the layer
 * that only reserves height rendering a plain view instead. Two things make
 * that view inert: a mounted `Pressable` is a touch area even with its
 * `onPress` gone, because Pressability still hands the host view a click
 * handler; and NativeWind turns any element whose `className` carries a press
 * variant into a `Pressable` of its own. The reserved view therefore drops
 * every press variant a caller passes and keeps only the layout classes, so
 * the press feedback lives in the drawn layer alone.
 */
export function CardControl({ className, children, ...pressProps }: CardControlProps) {
  const reserved = useReservedHomeCardLayer();
  if (reserved) {
    const layout = className?.replaceAll(PRESS_FEEDBACK_VARIANT, '').replaceAll(/\s+/g, ' ').trim();
    return <View className={layout}>{children}</View>;
  }
  return (
    <Pressable className={cn('active:opacity-70', className)} {...pressProps}>
      {children}
    </Pressable>
  );
}

/**
 * One of the frame's stacked cards. The reserved layer is painted at zero
 * opacity behind the drawn one and holds no touch targets; only its height
 * counts, so the frame keeps the larger card's frame when the other shows. The
 * drawn state, the transparency and the inert flag are one value here, so the
 * two cards can never be tappable and invisible at the same time.
 */
function CardLayer({
  reserved,
  className,
  children,
}: Readonly<{ reserved: boolean; className: string; children: ReactNode }>) {
  return (
    <ReservedCardLayerContext.Provider value={reserved}>
      <View
        className={cn(className, reserved && 'opacity-0')}
        pointerEvents={reserved ? 'none' : 'auto'}
        accessibilityElementsHidden={reserved}
        importantForAccessibility={reserved ? 'no-hide-descendants' : 'auto'}
      >
        {children}
      </View>
    </ReservedCardLayerContext.Provider>
  );
}

export function AdaptiveHomeCardFrame({
  live,
  briefing,
  showBriefing,
}: Readonly<AdaptiveHomeCardFrameProps>) {
  return (
    <View className="flex-row items-stretch overflow-hidden rounded-2xl border border-border bg-card">
      <CardLayer reserved={showBriefing} className="w-full shrink-0">
        {live}
      </CardLayer>
      {/* Overlapping in-flow siblings let native layout reserve the larger intrinsic height. */}
      <CardLayer reserved={!showBriefing} className="-ms-[100%] w-full shrink-0">
        {briefing}
      </CardLayer>
      <View
        className="-ms-[100%] w-full shrink-0 opacity-0"
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <View className="px-4 py-3">
          {[0, 1, 2, 3].map(row => (
            <View key={row} className={`${DENSE_ROW_FRAME_CLASS} justify-center`}>
              <Text className="text-sm">{'\u200B'}</Text>
            </View>
          ))}
        </View>
        <View className="h-px bg-border" />
        <View className="min-h-[68px] justify-center px-4 py-3">
          <Text className="text-sm">{'\u200B\n\u200B'}</Text>
        </View>
      </View>
    </View>
  );
}
