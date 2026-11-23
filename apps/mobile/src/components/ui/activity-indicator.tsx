import { useTranslation } from 'react-i18next';

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
  const { t } = useTranslation();
  const dimension = indicatorDimension(size);

  if (!reducedMotion) {
    return (
      <NativeActivityIndicator
        {...props}
        // The platform control animates, so it carries no role of its own: a
        // reader announces an unnamed progress bar, and Android's indicator has
        // no label at all. Both branches therefore speak the same wait.
        accessibilityRole={props.accessibilityRole ?? 'progressbar'}
        accessibilityLabel={props.accessibilityLabel ?? t('common.loading')}
        accessibilityState={{ ...props.accessibilityState, busy: animating }}
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

  // A stopped indicator that hides itself leaves the accessibility tree in the
  // native branch; the glyph below keeps its box as a transparent marker so
  // nothing shifts, so hide this wrapper's node instead.
  const hiddenFromA11y = !animating && hidesWhenStopped;

  return (
    <View
      {...props}
      // Reduced motion changes the animation, not the information: the static
      // marker takes the progress semantics the platform control presents, so a
      // wait that relies on this component still reports itself to a reader.
      accessible={!hiddenFromA11y && (props.accessible ?? true)}
      accessibilityRole={props.accessibilityRole ?? 'progressbar'}
      accessibilityLabel={props.accessibilityLabel ?? t('common.loading')}
      accessibilityState={{ ...props.accessibilityState, busy: animating }}
      accessibilityElementsHidden={hiddenFromA11y}
      importantForAccessibility={hiddenFromA11y ? 'no-hide-descendants' : 'auto'}
      className="items-center justify-center"
      // A static glyph would otherwise shrink to its own measured size, so the
      // wrapper keeps the box the native branch pins.
      // eslint-disable-next-line react-native/no-inline-styles -- a numeric size cannot be a compiled class
      style={[style, { width: dimension, height: dimension }]}
    >
      <Loader2 size={dimension} color={hiddenFromA11y ? 'transparent' : color} />
    </View>
  );
}
