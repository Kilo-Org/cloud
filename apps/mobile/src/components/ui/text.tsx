import * as Slot from '@rn-primitives/slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { I18nManager, Text as RNText, type Role, type TextStyle } from 'react-native';

import { RTL_NO_LETTER_SPACING, RTL_WRITING_DIRECTION, textLetterSpacing } from '@/lib/rtl-text';
import { cn } from '@/lib/utils';

const textVariants = cva('text-foreground text-base font-medium', {
  variants: {
    variant: {
      default: '',
      h1: 'text-center text-4xl font-bold tracking-tight',
      h2: 'border-border border-b pb-2 text-3xl font-semibold tracking-tight',
      h3: 'text-2xl font-semibold tracking-tight',
      h4: 'text-xl font-semibold tracking-tight',
      p: 'mt-3 leading-7',
      blockquote: 'mt-4 border-l-2 pl-3 italic',
      code: 'bg-muted relative rounded px-[0.3rem] py-[0.2rem] font-mono-semibold text-sm',
      lead: 'text-muted-foreground text-xl',
      large: 'text-lg font-semibold',
      small: 'text-sm font-medium leading-none',
      muted: 'text-muted-foreground text-sm',
      mono: 'font-mono-medium text-sm',
      eyebrow: 'font-mono-medium text-[10px] text-muted-foreground',
    },
  },
  defaultVariants: {
    variant: 'default',
  },
});

type TextVariantProps = VariantProps<typeof textVariants>;

type TextVariant = NonNullable<TextVariantProps['variant']>;

const ROLE = {
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
} satisfies Partial<Record<TextVariant, Role>>;

const ARIA_LEVEL = {
  h1: '1',
  h2: '2',
  h3: '3',
  h4: '4',
} satisfies Partial<Record<TextVariant, string>>;

/**
 * The eyebrow's Latin display treatment: full capitals, letterspaced. It is an
 * LTR-only addition to the variant because `letter-spacing` pulls a cursive
 * script apart — an Arabic eyebrow renders 'الجلسات' as 'ال جلسا ت'. An RTL
 * interface keeps the mono family, size and color and drops both classes.
 *
 * Exported so the eyebrow-scale labels rendered outside the variant — the
 * `SectionHeader` action link — carry the identical treatment instead of a
 * second copy of the class string that can drift.
 */
export const EYEBROW_LATIN_DISPLAY = 'uppercase tracking-[1.5px]';

const TextClassContext = React.createContext<string | undefined>(undefined);

function Text({
  className,
  asChild = false,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof RNText> &
  TextVariantProps &
  React.RefAttributes<RNText> & {
    asChild?: boolean;
  }) {
  const textClass = React.useContext(TextClassContext);
  const Component = asChild ? Slot.Text : RNText;
  // Letter spacing — Tailwind's `tracking-*` — is a Latin typographic device:
  // it opens every glyph from its neighbour. A joined-script run (Arabic,
  // Farsi, Urdu, Kurdish, Pashto) is one connected shape, so any tracking class
  // on it would pull apart letters the script joins; the app's RTL catalogs do
  // not take tracking either. The reset therefore follows the script whatever
  // the interface direction is, and an RTL interface whatever the script is.
  // Latin runs in LTR keep the style's tracking. The caller's own style stays
  // last, so an explicit `letterSpacing` still wins.
  const ownStyles = [
    I18nManager.isRTL ? RTL_WRITING_DIRECTION : undefined,
    textLetterSpacing(props.children) ?? (I18nManager.isRTL ? RTL_NO_LETTER_SPACING : undefined),
  ].filter((style): style is TextStyle => style !== undefined);
  return (
    <Component
      className={cn(
        textVariants({ variant }),
        variant === 'eyebrow' && !I18nManager.isRTL && EYEBROW_LATIN_DISPLAY,
        textClass,
        className
      )}
      role={variant ? ROLE[variant as keyof typeof ROLE] : undefined}
      aria-level={variant ? ARIA_LEVEL[variant as keyof typeof ARIA_LEVEL] : undefined}
      {...props}
      style={ownStyles.length > 0 ? [...ownStyles, props.style] : props.style}
    />
  );
}

export { Text, TextClassContext };
