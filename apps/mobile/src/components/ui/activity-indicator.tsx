import { Loader2 } from '@/components/ui/icons';
import {
  type ActivityIndicatorProps,
  ActivityIndicator as NativeActivityIndicator,
  View,
} from 'react-native';

import { useMotionPolicy } from '@/lib/a11y/motion';

function indicatorDimension(size: ActivityIndicatorProps['size']): number {
  if (size === 'large') {
    return 36;
  }
  if (size === 'small' || size === undefined) {
    return 20;
  }
  return size;
}

export function ActivityIndicator({
  size = 'small',
  color,
  animating = true,
  hidesWhenStopped = true,
  style,
  ...props
}: Readonly<ActivityIndicatorProps>) {
  const { reducedMotion } = useMotionPolicy();
  const dimension = indicatorDimension(size);

  if (!reducedMotion) {
    return (
      <NativeActivityIndicator
        {...props}
        animating={animating}
        color={color}
        hidesWhenStopped={hidesWhenStopped}
        size={size}
        // Own the drawn box in this branch too. The native indicator's own
        // measurement can report a near-zero size inside a fixed-size parent
        // (Button's reserved busy slot), which leaves the slot looking empty in
        // flight; pinning the view to `dimension` makes the native spinner fill
        // the same box the reduced-motion branch draws its glyph in.
        // eslint-disable-next-line react-native/no-inline-styles -- a numeric size cannot be a compiled class
        style={[style, { width: dimension, height: dimension }]}
      />
    );
  }

  return (
    <View
      {...props}
      className="items-center justify-center"
      // The static glyph stands in for the native indicator, so the wrapper
      // owns the indicator's box: pinned to the same dimension the native
      // branch renders at, the drawn marker keeps a visible size wherever it
      // mounts - inside Button's reserved busy slot included - instead of
      // shrinking to whatever the glyph's own measurement reports.
      // eslint-disable-next-line react-native/no-inline-styles -- a numeric size cannot be a compiled class
      style={[style, { width: dimension, height: dimension }]}
    >
      <Loader2 size={dimension} color={!animating && hidesWhenStopped ? 'transparent' : color} />
    </View>
  );
}
