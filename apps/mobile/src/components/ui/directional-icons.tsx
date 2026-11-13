import { type ComponentProps, type ComponentType, forwardRef, type Ref } from 'react';
import { I18nManager, View, type ViewStyle } from 'react-native';

import {
  ArrowLeft,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  LogOut,
  type LucideIcon,
} from '@/components/ui/icons';

type IconProps = ComponentProps<typeof ChevronRight>;

/**
 * Direction-aware icon wrappers. In RTL the native direction mirrors the
 * chrome, so a "back" chevron points right, a "forward"/trailing-disclosure
 * chevron points left, and a trailing arrow points left. Callers that mean
 * back, forward, or trailing disclosure must use these instead of the raw
 * Lucide icons.
 *
 * `DirectionalLogOut` is the other kind: Lucide ships no mirrored sign-out
 * glyph, so it keeps the one glyph and flips it in RTL. It is a `forwardRef`
 * component because a row that takes a `LucideIcon` — a
 * `ForwardRefExoticComponent` — accepts no plain function.
 */
export function DirectionalChevronLeft(props: IconProps) {
  const Icon = I18nManager.isRTL ? ChevronRight : ChevronLeft;
  return <Icon {...props} />;
}

export function DirectionalChevronRight(props: IconProps) {
  const Icon = I18nManager.isRTL ? ChevronLeft : ChevronRight;
  return <Icon {...props} />;
}

export function DirectionalArrowLeft(props: IconProps) {
  const Icon = I18nManager.isRTL ? ArrowRight : ArrowLeft;
  return <Icon {...props} />;
}

export function DirectionalArrowRight(props: IconProps) {
  const Icon = I18nManager.isRTL ? ArrowLeft : ArrowRight;
  return <Icon {...props} />;
}

const MIRRORED_GLYPH: ViewStyle = {
  // `alignSelf` keeps the frame the glyph's own size in a stretching row, so the
  // flip turns about the glyph instead of a wider box.
  alignSelf: 'center',
  transform: [{ scaleX: -1 }],
};

/**
 * The sign-out arrow leaves the row toward the trailing edge in LTR. An RTL row
 * mirrors that layout, so the arrow must leave toward the start edge, which
 * means flipping the glyph: an arrow pointing into the row reads as its
 * opposite action.
 *
 * The flip is a frame around the glyph, not an overwrite of its style, so every
 * style property the caller passes reaches the glyph unchanged.
 */
export const DirectionalLogOut: LucideIcon = forwardRef<unknown, IconProps>((props, ref) => {
  // Lucide's public icon type omits the `ref` its implementation still forwards
  // to the svg root, so passing one through needs the prop here. Read at render
  // so a caller's icon mock need not name this glyph.
  const Glyph = LogOut as ComponentType<IconProps & { ref?: Ref<unknown> }>;
  const icon = <Glyph {...props} ref={ref} />;
  if (!I18nManager.isRTL) {
    return icon;
  }
  return <View style={MIRRORED_GLYPH}>{icon}</View>;
});
DirectionalLogOut.displayName = 'DirectionalLogOut';
