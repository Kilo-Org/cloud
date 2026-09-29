import * as Slot from '@rn-primitives/slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { I18nManager, Text as RNText, type Role } from 'react-native';

import {
  hasRtlScript,
  RTL_NO_LETTER_SPACING,
  RTL_WRITING_DIRECTION,
  withoutMonoFamily,
} from '@/lib/rtl-text';
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
 * The eyebrow's Latin display treatment: full capitals, letterspaced. It is
 * dropped for RTL-script copy in an RTL interface (`hasRtlScript`: the app
 * ships Arabic-script languages and Hebrew): `letter-spacing` pulls a
 * cursive script apart — an Arabic eyebrow renders 'الجلسات' as 'ال جلسا ت'
 * — and that copy also drops the mono family (see `withoutMonoFamily`).
 * Latin copy, and RTL-script copy in an LTR interface, keep the treatment.
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
  const isRTL = I18nManager.isRTL;
  const isRtlScript = hasRtlScript(props.children);
  const classes = cn(
    textVariants({ variant }),
    variant === 'eyebrow' && !(isRTL && isRtlScript) && EYEBROW_LATIN_DISPLAY,
    textClass,
    className
  );
  return (
    <Component
      className={isRTL && isRtlScript ? withoutMonoFamily(classes) : classes}
      role={variant ? ROLE[variant as keyof typeof ROLE] : undefined}
      aria-level={variant ? ARIA_LEVEL[variant as keyof typeof ARIA_LEVEL] : undefined}
      {...props}
      style={
        isRTL
          ? [RTL_WRITING_DIRECTION, isRtlScript ? RTL_NO_LETTER_SPACING : undefined, props.style]
          : props.style
      }
    />
  );
}

export { Text, TextClassContext };
