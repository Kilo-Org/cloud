import { Pressable } from 'react-native';

import { ICON_TARGET_BOX_CLASS } from '@/lib/a11y/tap-target';
import { cn } from '@/lib/utils';

// The icon renders centred in the box, so children are content, never
// Pressable's render-prop form.
type IconButtonProps = Omit<React.ComponentProps<typeof Pressable>, 'children'> & {
  children?: React.ReactNode;
};

/**
 * The shared icon-only control: a `Pressable` whose own box is the 48dp
 * target Android requires (`ICON_TARGET_BOX_CLASS`). The audit reads the
 * node's view rect, so the box alone carries the measured size — no
 * `hitSlop` involved. Callers pass the icon as children and own its colour;
 * the box centres it.
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
      className={cn(ICON_TARGET_BOX_CLASS, 'active:opacity-70', className)}
      hitSlop={hitSlop}
      accessibilityRole={accessibilityRole}
      {...props}
    >
      {children}
    </Pressable>
  );
}

export { IconButton };
export type { IconButtonProps };
