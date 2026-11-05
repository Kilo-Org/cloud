import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';

import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { Text, TextClassContext } from '@/components/ui/text';
import { COMPACT_BUTTON_HIT_SLOP, ICON_TARGET_BOX_CLASS } from '@/lib/a11y/tap-target';
import { type ThemeColors, useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'group shrink-0 flex-row items-center justify-center rounded-md shadow-none',
  {
    variants: {
      variant: {
        default: 'bg-primary active:opacity-80 shadow-sm shadow-[#0000000D]',
        destructive: 'bg-destructive-solid active:opacity-80 shadow-sm shadow-[#0000000D]',
        // The dark card surface sits a step above the near-black background, and
        // the default hairline (7% white) is too faint to separate the control
        // from it, so an outlined control would read as unpainted black-on-black
        // in dark mode. Same surface/border pair the app's other dark cards use.
        outline:
          'border-border bg-card dark:border-neutral-700 dark:bg-secondary active:opacity-80 border shadow-sm shadow-[#0000000D]',
        // A destructive action that shares a footer with a filled primary must
        // not compete with it for attention: the fill stays with the safe,
        // forward action, so the destructive one keeps its warning ink and
        // outline and paints no fill of its own.
        'outline-destructive':
          'border-destructive bg-card dark:bg-secondary active:opacity-80 border shadow-sm shadow-[#0000000D]',
        // A filled neutral action keeps its own fill rather than the surface
        // token: `--secondary` is also the dark card an outlined control paints
        // (above), so a filled action in that colour reads as the same control
        // as the outlined one beside it, as it did in the discard-draft sheet
        // and the permission card. `--secondary-fill` equals `--secondary` in
        // light and takes a visible step above it in dark.
        secondary: 'bg-secondary-fill active:opacity-80 shadow-sm shadow-[#0000000D]',
        ghost: 'active:opacity-60',
        link: '',
        // A soft accent action is low-emphasis, so it paints a tint of the
        // accent rather than the full-strength surface user bubbles fill with.
        // The tint is what keeps it behind a filled primary: in dark mode that
        // primary already fills with #ffdd00, and a solid accent-soft button
        // could not be told apart from it.
        'accent-soft': 'bg-accent-soft-tint active:opacity-80 shadow-sm shadow-[#0000000D]',
      },
      size: {
        // min-h (not fixed h) so a button with a label grows to fit text scaled
        // by large Dynamic Type instead of clipping it; the min still guarantees
        // the 48pt action / 44pt default/lg / 46pt-reach sm target, whose 36pt
        // frame carries the rest as `COMPACT_BUTTON_HIT_SLOP`.
        // `icon` has no label to scale, so it is exactly the shared icon target
        // (`ICON_TARGET_BOX_CLASS`): the audit reads the node's own view rect, so
        // a smaller frame plus `hitSlop` would still measure under Android's
        // 48dp minimum. The glyph keeps its own size and the box centres it.
        // Use px because native rem defaults to 14pt, not 16pt.
        default: 'min-h-[44px] px-4 py-2',
        sm: 'min-h-[36px] rounded-md px-3 py-1.5',
        lg: 'min-h-[44px] rounded-md px-6 py-2',
        action: 'min-h-[48px] px-4 py-2',
        icon: ICON_TARGET_BOX_CLASS,
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

// The row gap lives in its own variant so the busy label wrapper, which holds
// the children one level deeper, spaces them exactly as the row would.
const buttonGapVariants = cva('', {
  variants: {
    size: {
      default: 'gap-2',
      sm: 'gap-1.5',
      lg: 'gap-2',
      action: 'gap-2',
      icon: '',
    },
  },
  defaultVariants: {
    size: 'default',
  },
});

// While `loading` is on, the spinner replaces the label instead of sitting
// beside it. The label stays in the row at zero opacity, so a content-sized
// button keeps exactly the width its label needs and nothing shifts when the
// request starts or ends; the spinner is painted over the button's centre, out
// of flow, so it adds no width of its own. The hidden label also leaves the
// accessibility tree, because the button carries its own busy name.
export const BUTTON_BUSY_LABEL_CLASS = 'min-w-0 shrink flex-row items-center justify-center';
export const BUTTON_BUSY_OVERLAY_CLASS = 'absolute inset-0 items-center justify-center';
const BUTTON_BUSY_MARK_SIZE = 20;
// Android's native arc can shrink to a dot; iOS uses a spoke spinner.
const ANDROID_BUSY_TRACK_SIZE = 17;

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

type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>['variant']>;

/**
 * Each variant's ink in one place: the class its label paints and the theme
 * token its busy mark follows. The mark has to read in the label's own colour —
 * a busy button shows the mark where the label was, and a still capture of the
 * platform indicator is otherwise a speck on the fill — so the two columns
 * cannot be kept apart. Recording both here makes a variant added to
 * `buttonVariants` without an ink pair, or an ink pair naming a token the
 * palette does not define, a type error instead of a mark in the default
 * variant's colour.
 */
const BUTTON_INK = {
  default: { label: 'text-primary-foreground', mark: 'primaryForeground' },
  destructive: {
    label: 'text-destructive-solid-foreground',
    mark: 'destructiveSolidForeground',
  },
  outline: { label: 'text-foreground', mark: 'foreground' },
  'outline-destructive': { label: 'text-destructive', mark: 'destructive' },
  secondary: { label: 'text-secondary-foreground', mark: 'secondaryForeground' },
  ghost: { label: 'text-foreground', mark: 'foreground' },
  link: { label: 'text-primary group-active:underline', mark: 'primary' },
  'accent-soft': {
    label: 'text-accent-soft-tint-foreground',
    mark: 'accentSoftTintForeground',
  },
} as const satisfies Record<ButtonVariant, { label: string; mark: keyof ThemeColors }>;

/**
 * The label column of `BUTTON_INK`, keyed by the variant union. The table above
 * is what makes it complete and what ties each label to its mark; `fromEntries`
 * only rebuilds the same keys and widens them to `string`, so the record type
 * restores the union cva reads its `variant` prop from.
 */
const buttonLabelClasses = Object.fromEntries(
  Object.entries(BUTTON_INK).map(([variant, ink]) => [variant, ink.label])
) as Record<ButtonVariant, string>;

const buttonTextVariants = cva('text-foreground text-center text-sm font-semibold', {
  variants: {
    variant: buttonLabelClasses,
    size: {
      default: '',
      sm: '',
      lg: '',
      action: '',
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
    /** Disables the button and replaces its label with a centered ActivityIndicator. */
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
  // Dimming is a disabled signal, and a busy control has nothing visible to
  // signal with: the label is already transparent and the spinner sits alone in
  // the slot. Halving the control's opacity then halves the indicator too, which
  // leaves an icon-only button looking empty on a dark surface. Keep the busy
  // control at full strength in both themes.
  const isDimmed = isDisabled && !isPrimary && !loading;
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
  // inside the wrapper; it takes the same size gap the row would have applied.
  const busyLabelGap = buttonGapVariants({ size });
  const busyInk = colors[BUTTON_INK[variant ?? 'default'].mark];
  const busyMark = (
    <View
      className="items-center justify-center"
      // eslint-disable-next-line react-native/no-inline-styles -- a numeric size cannot be a compiled class
      style={{ width: BUTTON_BUSY_MARK_SIZE, height: BUTTON_BUSY_MARK_SIZE }}
    >
      {Platform.OS === 'android' ? (
        <View className="absolute inset-0 items-center justify-center">
          <View
            className="rounded-full border-2"
            // eslint-disable-next-line react-native/no-inline-styles -- a numeric size cannot be a compiled class
            style={{
              width: ANDROID_BUSY_TRACK_SIZE,
              height: ANDROID_BUSY_TRACK_SIZE,
              borderColor: busyInk,
            }}
          />
        </View>
      ) : null}
      <ActivityIndicator accessible={false} size="small" color={busyInk} />
    </View>
  );
  const busyIndicator = loading ? busyMark : null;
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
          buttonGapVariants({ size }),
          isMutedDisabled && 'bg-primary-disabled',
          className
        )}
        role="button"
        disabled={isDisabled}
        accessibilityLabel={resolvedLabel}
        accessibilityState={{
          ...accessibilityState,
          disabled: isDisabled,
          // A caller that shows its own busy response (for example an icon that
          // spins while the same glyph stays drawn) declares `busy` without
          // opting into the loading layout; `loading` still wins when it is set.
          busy: loading ?? accessibilityState?.busy,
        }}
        hitSlop={hitSlop ?? (size === 'sm' ? COMPACT_BUTTON_HIT_SLOP : undefined)}
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
          // The button already carries the busy state and its name, so the
          // mark inside it stays out of the accessibility tree instead of
          // adding a second stop that reads only the wait.
          <View
            className={BUTTON_BUSY_OVERLAY_CLASS}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            {busyMark}
          </View>
        ) : null}
        {size === 'icon' ? busyIndicator : null}
      </Pressable>
    </TextClassContext.Provider>
  );
}

export { Button };
export type { ButtonProps };
