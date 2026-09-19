import { Pressable } from 'react-native';

import { cn } from '@/lib/utils';

/**
 * Icon-only control with a layout box big enough to be tapped reliably.
 *
 * A control's accessibility node is its layout bounds — Android reports the
 * view rect and `hitSlop` is not part of it — so an icon rendered at its own
 * 16–22pt size reports a node under the 28dp minimum the accessibility check
 * enforces. Render the icon centered inside this 32pt box instead of passing
 * the icon's size through to the Pressable.
 *
 * `hitSlop` then lifts the effective target to 48pt on every side, past the
 * 44pt minimum DESIGN.md requires of compact controls on touch surfaces.
 */
type IconButtonProps = Omit<React.ComponentProps<typeof Pressable>, 'children'> & {
  children?: React.ReactNode;
};

export function IconButton({
  className,
  hitSlop = { top: 8, bottom: 8, left: 8, right: 8 },
  accessibilityRole = 'button',
  children,
  ...props
}: Readonly<IconButtonProps>) {
  return (
    <Pressable
      accessibilityRole={accessibilityRole}
      hitSlop={hitSlop}
      className={cn('h-[32px] w-[32px] items-center justify-center active:opacity-70', className)}
      {...props}
    >
      {children}
    </Pressable>
  );
}
