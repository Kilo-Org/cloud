import React, { isValidElement, type ReactNode } from 'react';
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

const buttonTextVariants = cva('text-foreground text-center text-sm font-semibold', {
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

/** A `ReactNode` string member, the only child a `Text` lays out as one run. */
function isStringChild(child: ReactNode): child is string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- ReactNode is a closed union; typeof is its string discriminant.
  return typeof child === 'string';
}

/** A `ReactNode` array member; `Array.isArray` alone narrows it to `any[]`. */
function isChildArray(children: ReactNode): children is ReactNode[] {
  return Array.isArray(children);
}

/**
 * The visible text a button carries: the strings the caller rendered as its
 * label, joined with spaces (the gap-2 row the styles draw). Non-string
 * children — icons, spinners — contribute nothing, so a text-free button
 * derives no label.
 */
function joinTextChildren(children: ReactNode): string | undefined {
  const parts: string[] = [];
  collectTextChildren(children, parts);
  const joined = parts.join(' ').trim();
  return joined.length > 0 ? joined : undefined;
}

function collectTextChildren(children: ReactNode, parts: string[]): void {
  if (isStringChild(children)) {
    parts.push(children);
    return;
  }
  if (isChildArray(children)) {
    for (const child of children) {
      collectTextChildren(child, parts);
    }
    return;
  }
  if (isTextElementWithChildString(children)) {
    parts.push(children.props.children);
  }
}

/**
 * The shared label element: one `Text` wrapping one string (the app's single
 * label shape, see `AGENTS.md`'s Text inputs rules). A `Text` wrapping
 * anything else — icons, nested runs — contributes nothing, so it never
 * invents a label the visible row does not read as.
 */
function isTextElementWithChildString(
  children: ReactNode
): children is React.ReactElement<{ children: string }> {
  return (
    isValidElement<{ children?: ReactNode }>(children) && isStringChild(children.props.children)
  );
}

function Button({
  className,
  variant,
  size,
  loading,
  disabled,
  accessibilityState,
  accessibilityLabel,
  hitSlop,
  children,
  ...props
}: ButtonProps) {
  const colors = useThemeColors();
  // Android keeps a busy button's last content description when `busy` flips
  // back to false and the view has no accessibility label (RN's
  // `BaseViewManager.updateViewContentDescription` only rewrites a non-empty
  // result), so the accessible name can stick at "busy" while the visible
  // label reads normally again. Deriving the label from the visible text
  // gives every busy cycle a non-empty label, so every state change rebuilds
  // the description from it. Explicit labels win; icon-only buttons have no
  // text to derive from and keep today's behavior.
  const derivedLabel =
    accessibilityLabel ?? (size === 'icon' ? undefined : joinTextChildren(children));
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
        accessibilityLabel={derivedLabel}
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
