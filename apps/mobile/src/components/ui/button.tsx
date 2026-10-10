import { cva, type VariantProps } from 'class-variance-authority';
import { Pressable, View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';

import { TextClassContext } from '@/components/ui/text';
import { type ThemeColors, useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'group shrink-0 flex-row items-center justify-center gap-2 rounded-md shadow-none',
  {
    variants: {
      variant: {
        default: 'bg-primary active:opacity-80 shadow-sm shadow-[#0000000D]',
        destructive: 'bg-destructive active:opacity-80 shadow-sm shadow-[#0000000D]',
        outline: 'border-border bg-card active:opacity-80 border shadow-sm shadow-[#0000000D]',
        secondary: 'bg-secondary active:opacity-80 shadow-sm shadow-[#0000000D]',
        ghost: 'active:opacity-60',
        link: '',
        'accent-soft': 'bg-accent-soft active:opacity-80 shadow-sm shadow-[#0000000D]',
      },
      size: {
        // min-h (not fixed h) so the button grows to fit text scaled by large
        // Dynamic Type instead of clipping the label; the min still guarantees
        // the 44pt (default/lg) / 36pt-plus-hitSlop (sm) touch target.
        // Use px because native rem defaults to 14pt, not 16pt.
        default: 'min-h-[44px] px-4 py-2',
        sm: 'min-h-[36px] gap-1.5 rounded-md px-3 py-1.5',
        lg: 'min-h-[44px] rounded-md px-6 py-2',
        icon: 'h-[44px] w-[44px]',
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

// The busy spinner is drawn inside a fixed-size slot before the label. The slot
// is rendered in both states - an empty 20pt box at rest, the spinner while
// `loading` is on - so flipping `loading` only swaps its contents: no box is
// added or removed and the label never shifts. An in-flow slot (rather than an
// absolute overlay pinned to the content edge) keeps the spinner beside a
// content-sized button's label instead of drawing it on top of the label.
// `shrink-0` is what makes the reservation hold: a flex child defaults to
// `flex-shrink: 1`, so a long or large-type label could compress the 20pt slot
// to a sliver and collapse the spinner inside it while the centered label
// stayed put (the 2026-09-29 device proof: identical label ink, near-zero busy
// ink in flight). The slot never gives up its box, in either motion branch.
export const BUTTON_BUSY_SLOT_CLASS = 'h-[20px] w-[20px] shrink-0 items-center justify-center';

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
  const isPrimary = (variant ?? 'default') === 'default';
  // A default-variant fill is a saturated brand colour with a contrasting ink
  // label. Halving the whole control's opacity for the disabled state
  // composites that pair into olive-on-olive (about 2.4:1 in light, 4.4:1 in
  // dark), and it also washes out any child that hard-codes primaryForeground.
  // A disabled (not busy) primary instead takes a muted fill that still
  // contrasts with the ink label, so the label stays legible. A busy primary
  // keeps the brand fill and its spinner so it still reads as working.
  const isMutedDisabled = isDisabled && !loading && isPrimary;
  const isDimmed = isDisabled && !isPrimary;
  // Reserve the busy slot whenever the caller opted into `loading` (even when
  // it is false), so the row has the same geometry before and during a request.
  // A button that never loads keeps its original layout. The fixed `icon` size
  // has no label to keep in place, so it shows the indicator inline instead of
  // reserving a slot that would overflow its 44pt box.
  const rendersBusySlot = loading !== undefined && size !== 'icon';
  const busyIndicator = loading ? (
    <ActivityIndicator size="small" color={spinnerColor(variant, colors)} />
  ) : null;
  return (
    <TextClassContext.Provider value={buttonTextVariants({ variant, size })}>
      <Pressable
        className={cn(
          isDimmed && 'opacity-50',
          buttonVariants({ variant, size }),
          isMutedDisabled && 'bg-primary-disabled',
          className
        )}
        role="button"
        disabled={isDisabled}
        accessibilityState={{ ...accessibilityState, disabled: isDisabled, busy: loading }}
        hitSlop={hitSlop ?? (size === 'sm' ? SM_HIT_SLOP : undefined)}
        {...props}
      >
        {rendersBusySlot ? (
          <View className={BUTTON_BUSY_SLOT_CLASS}>{busyIndicator}</View>
        ) : (
          busyIndicator
        )}
        {children}
        {rendersBusySlot ? (
          // Mirrors the leading slot (and the row's own gap), so the label keeps
          // the button's centre instead of drifting toward the trailing edge.
          <View className={BUTTON_BUSY_SLOT_CLASS} />
        ) : null}
      </Pressable>
    </TextClassContext.Provider>
  );
}

export { Button };
export type { ButtonProps };
