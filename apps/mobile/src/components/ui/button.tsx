import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { Pressable, View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';

import { Text, TextClassContext } from '@/components/ui/text';
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

// While `loading` is on, the spinner replaces the label instead of sitting
// beside it. The label stays in the row at zero opacity, so a content-sized
// button keeps exactly the width its label needs and nothing shifts when the
// request starts or ends; the spinner is painted over the button's centre, out
// of flow, so it adds no width of its own. The hidden label also leaves the
// accessibility tree, because the button carries its own busy name.
export const BUTTON_BUSY_LABEL_CLASS = 'min-w-0 shrink flex-row items-center justify-center';
export const BUTTON_BUSY_OVERLAY_CLASS = 'absolute inset-0 items-center justify-center';

/**
 * The visible text of the button's children, for a label a loading button can
 * hand to the accessibility layer when the caller gave none. Text children
 * carry their caption in `props.children`; glyphs contribute nothing, so a
 * caller with an icon-only button must label it itself.
 */
function flattenChildrenText(children: React.ReactNode): string | undefined {
  const parts: string[] = [];
  const visit = (node: React.ReactNode): void => {
    if (node === null || node === undefined || node === true || node === false) {
      return;
    }
    if (Array.isArray(node)) {
      const items: React.ReactNode[] = node;
      for (const child of items) {
        visit(child);
      }
      return;
    }
    if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
      visit(node.props.children);
      return;
    }
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- ReactNode has no non-typeof way to detect its plain-string variant
    if (typeof node === 'string' || typeof node === 'number') {
      parts.push(String(node));
    }
  };
  visit(children);
  const text = parts.join(' ').replaceAll(/\s+/g, ' ').trim();
  return text === '' ? undefined : text;
}

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
  // On Android, a node's accessible name is only rewritten while the incoming
  // state still carries `busy`. A loading button therefore keeps announcing its
  // busy state after the request settles unless its label prop holds a real
  // name for the `busy: true → false` transition to write. Pass the caller's
  // label when given; when a call site opted into `loading` without one,
  // derive it from the visible child text, so the announced name always
  // matches what is on screen.
  const resolvedLabel =
    accessibilityLabel ?? (loading !== undefined ? flattenChildrenText(children) : undefined);
  // The label lives in a wrapper whenever the caller opted into `loading` (even
  // when it is false), so the wrapper element and its geometry stay identical
  // across a request; only its opacity changes. A button that never loads keeps
  // its original children untouched. The fixed `icon` size has no label to
  // replace, so it draws the indicator inline instead.
  const usesBusyLayout = loading !== undefined && size !== 'icon';
  // The children sit one level deeper in that layout, so their spacing moves
  // inside the wrapper: it takes the gap the row's size sets, or a compact
  // button would change from 6px to 8px between its icon and label.
  const busyLabelGap = size === 'sm' ? 'gap-1.5' : 'gap-2';
  const busyIndicator = loading ? (
    <ActivityIndicator size="small" color={spinnerColor(variant, colors)} />
  ) : null;
  // A bare string or number child has no host to draw on: Pressable is a View,
  // and a View draws no text, so the button collapses to its padding and the
  // label disappears while the accessibility tree still names it. Wrap scalars
  // in the themed label Text so every caller's label renders. Array children
  // get the same treatment per entry; whitespace-only strings are skipped so
  // JSX spacing idioms between an icon and a labeled element keep their today
  // behaviour (they draw nothing in a View, and the row's gap does the spacing).
  // Elements pass through untouched.
  // oxlint-disable anti-slop/no-runtime-typeof -- ReactNode has no non-typeof way to detect its plain-string/number variants
  const childrenIsScalar = typeof children === 'string' || typeof children === 'number';
  let normalizedChildren: React.ReactNode = children;
  if (childrenIsScalar) {
    normalizedChildren = <Text>{children}</Text>;
  } else if (Array.isArray(children)) {
    normalizedChildren = children.map((child, index) => {
      if (typeof child === 'string' && /^\s*$/.test(child)) {
        return child;
      }
      const childIsScalar = typeof child === 'string' || typeof child === 'number';
      return (
        <React.Fragment key={index}>{childIsScalar ? <Text>{child}</Text> : child}</React.Fragment>
      );
    });
  }
  // oxlint-enable anti-slop/no-runtime-typeof
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
        accessibilityLabel={resolvedLabel}
        accessibilityState={{ ...accessibilityState, disabled: isDisabled, busy: loading }}
        hitSlop={hitSlop ?? (size === 'sm' ? SM_HIT_SLOP : undefined)}
        {...props}
      >
        {usesBusyLayout ? (
          <View
            className={cn(BUTTON_BUSY_LABEL_CLASS, busyLabelGap, loading && 'opacity-0')}
            accessibilityElementsHidden={loading}
            importantForAccessibility={loading ? 'no-hide-descendants' : 'auto'}
          >
            {normalizedChildren}
          </View>
        ) : (
          normalizedChildren
        )}
        {loading && size !== 'icon' ? (
          <View className={BUTTON_BUSY_OVERLAY_CLASS}>
            <ActivityIndicator size="small" color={spinnerColor(variant, colors)} />
          </View>
        ) : null}
        {size === 'icon' ? busyIndicator : null}
      </Pressable>
    </TextClassContext.Provider>
  );
}

export { Button };
export type { ButtonProps };
