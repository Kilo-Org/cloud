import { Pressable } from 'react-native';

import { COMPACT_CONTROL_BOX_CLASS, COMPACT_CONTROL_HIT_SLOP_DP } from '@/lib/a11y/tap-target';
import { cn } from '@/lib/utils';

// The 32pt compact box already clears the control-size audit's floor; the
// slop only widens the touch region to DESIGN.md:364's 44pt target. `hitSlop`
// is not part of the control's own node, so the box class above carries the
// measured size.
const COMPACT_CONTROL_HIT_SLOP = {
  top: COMPACT_CONTROL_HIT_SLOP_DP,
  bottom: COMPACT_CONTROL_HIT_SLOP_DP,
  left: COMPACT_CONTROL_HIT_SLOP_DP,
  right: COMPACT_CONTROL_HIT_SLOP_DP,
};

// The icon renders centred in the box, so children are content, never
// Pressable's render-prop form.
type IconButtonProps = Omit<React.ComponentProps<typeof Pressable>, 'children'> & {
  children?: React.ReactNode;
};

/**
 * The shared icon-only control: a compact `Pressable` whose own box carries
 * the tap target, with a per-side `hitSlop` that widens the reach to
 * `DESIGN.md:364`'s 44pt without growing the visual control. Callers pass the
 * icon as children and own its colour; the box centres it.
 */
function IconButton({
  className,
  hitSlop,
  accessibilityRole = 'button',
  children,
  ...props
}: IconButtonProps) {
  return (
    <Pressable
      className={cn(COMPACT_CONTROL_BOX_CLASS, 'active:opacity-70', className)}
      hitSlop={hitSlop ?? COMPACT_CONTROL_HIT_SLOP}
      accessibilityRole={accessibilityRole}
      {...props}
    >
      {children}
    </Pressable>
  );
}

export { IconButton };
export type { IconButtonProps };
