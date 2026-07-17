import { cva, type VariantProps } from 'class-variance-authority';
import { ActivityIndicator, Pressable } from 'react-native';

import { TextClassContext } from '@/components/ui/text';
import { type ThemeColors, useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'group shrink-0 flex-row items-center justify-center gap-2 rounded-md shadow-none',
  {
    variants: {
      variant: {
        default: 'bg-primary active:opacity-80 shadow-sm shadow-black/5',
        destructive: 'bg-destructive active:opacity-80 shadow-sm shadow-black/5',
        outline: 'border-border bg-card active:opacity-80 border shadow-sm shadow-black/5',
        secondary: 'bg-secondary active:opacity-80 shadow-sm shadow-black/5',
        ghost: 'active:opacity-60',
        link: '',
        'accent-soft': 'bg-accent-soft active:opacity-80 shadow-sm shadow-black/5',
      },
      size: {
        // min-h (not fixed h) so the button grows to fit text scaled by large
        // Dynamic Type instead of clipping the label; the min still guarantees
        // the 44pt (default/lg) / 36pt-plus-hitSlop (sm) touch target.
        default: 'min-h-11 px-4 py-2',
        sm: 'min-h-9 gap-1.5 rounded-md px-3 py-1.5',
        lg: 'min-h-11 rounded-md px-6 py-2',
        icon: 'h-11 w-11',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

// sm is 36pt tall; expand the touchable area by 4pt on every edge to reach 44pt
// without changing the compact visual size.
const SM_HIT_SLOP = { top: 4, bottom: 4, left: 4, right: 4 };

// Spinner color per variant, matching that variant's text color (see
// buttonTextVariants below). accent-soft's foreground isn't in useThemeColors
// but is identical in both themes (global.css --accent-soft-foreground).
function spinnerColor(variant: ButtonProps['variant'], colors: ThemeColors): string {
  if (variant === 'outline' || variant === 'secondary' || variant === 'ghost') {
    return colors.foreground;
  }
  if (variant === 'link') {
    return colors.primary;
  }
  if (variant === 'accent-soft') {
    return '#1A1A10';
  }
  // default, destructive
  return colors.primaryForeground;
}

const buttonTextVariants = cva('text-foreground text-sm font-semibold', {
  variants: {
    variant: {
      default: 'text-primary-foreground',
      destructive: 'text-destructive-foreground',
      outline: 'text-foreground',
      secondary: 'text-secondary-foreground',
      ghost: 'text-foreground',
      link: 'text-primary group-active:underline',
      'accent-soft': 'text-accent-soft-foreground',
    },
    size: {
      default: '',
      sm: '',
      lg: '',
      icon: '',
    },
  },
  defaultVariants: {
    variant: 'default',
    size: 'default',
  },
});

type ButtonProps = Omit<React.ComponentProps<typeof Pressable>, 'children'> &
  React.RefAttributes<typeof Pressable> &
  VariantProps<typeof buttonVariants> & {
    /** Disables the button and shows an ActivityIndicator alongside its content. */
    loading?: boolean;
    children?: React.ReactNode;
  };

function Button({
  className,
  variant,
  size,
  loading,
  disabled,
  accessibilityState,
  hitSlop,
  children,
  ...props
}: ButtonProps) {
  const colors = useThemeColors();
  const isDisabled = Boolean(disabled) || Boolean(loading);
  return (
    <TextClassContext.Provider value={buttonTextVariants({ variant, size })}>
      <Pressable
        className={cn(isDisabled && 'opacity-50', buttonVariants({ variant, size }), className)}
        role="button"
        disabled={isDisabled}
        accessibilityState={{ ...accessibilityState, disabled: isDisabled, busy: loading }}
        hitSlop={hitSlop ?? (size === 'sm' ? SM_HIT_SLOP : undefined)}
        {...props}
      >
        {loading ? <ActivityIndicator size="small" color={spinnerColor(variant, colors)} /> : null}
        {children}
      </Pressable>
    </TextClassContext.Provider>
  );
}

export { Button, buttonTextVariants, buttonVariants };
export type { ButtonProps };
