import * as Slot from '@rn-primitives/slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { I18nManager, Text as RNText, type Role } from 'react-native';

import { useSystemFontScale } from '@/lib/font-scale/system-font-scale-context';
import { resolveFontScaleCap } from '@/lib/font-scale/text-scale-cap';

import {
  containsJoinedScript,
  hasRtlScript,
  NATURAL_LETTER_SPACING,
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
      p: 'mt-3 leading-[1.75rem]',
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

/**
 * The heading variants and the accessibility an assistive reader needs to
 * navigate by them. Role and level travel together in one entry per heading, so
 * a heading variant cannot take a role without its level (or the reverse), and
 * the lookup is keyed by `TextVariant`: a heading typo is a type error and a
 * non-heading variant reads `undefined` without an unchecked key cast.
 */
const HEADING_A11Y = new Map<TextVariant, { role: Role; level: string }>([
  ['h1', { role: 'heading', level: '1' }],
  ['h2', { role: 'heading', level: '2' }],
  ['h3', { role: 'heading', level: '3' }],
  ['h4', { role: 'heading', level: '4' }],
]);

/**
 * The eyebrow's Latin display treatment: full capitals, letterspaced. It is
 * dropped for RTL-script copy in an RTL interface (`hasRtlScript`: the app
 * ships Arabic-script languages and Hebrew): `letter-spacing` pulls a
 * cursive script apart — an Arabic eyebrow renders 'الجلسات' as 'ال جلسا ت'
 * — and that copy also drops the mono family (see `withoutMonoFamily`).
 * Latin copy keeps the treatment in either direction, and in an LTR interface
 * the class stays on a joined-script label while the letter-spacing reset
 * draws it inert (`NATURAL_LETTER_SPACING`, `text.mounted.test.tsx`).
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
  TextVariantProps & {
    asChild?: boolean;
  }) {
  const textClass = React.useContext(TextClassContext);
  const fontScaleCap = resolveFontScaleCap(useSystemFontScale(), props.maxFontSizeMultiplier);
  const Component = asChild ? Slot.Text : RNText;
  const isRTL = I18nManager.isRTL;
  // The shared text primitive re-renders whenever its parent does (streamed chat
  // copy is re-resolved on every parent render), so the two script scans — the
  // only work here that looks at the copy character by character — are cached
  // against the child tree. The reading of their results, the class string below
  // and the writing direction are unchanged.
  const { isRtlScript, joinedScript } = React.useMemo(
    () => ({
      // The font family is the script's, not the interface's: JetBrains Mono
      // ships no Arabic or Hebrew glyphs, so the copy that uses either drops the
      // family in both directions (`withoutMonoFamily`).
      isRtlScript: hasRtlScript(props.children),
      joinedScript: containsJoinedScript(props.children),
    }),
    [props.children]
  );
  // Letter-spacing is the script's too. A joined script cannot take it in
  // either direction: an Arabic label on an LTR screen keeps its joins. An RTL
  // interface resets its RTL-script copy as well — a Hebrew label there would
  // take a spacing no Hebrew reader asked for — while Latin copy, in either
  // direction, keeps the tracking its class asks for (`NATURAL_LETTER_SPACING`).
  const resetsTracking = joinedScript || (isRTL && isRtlScript);
  const headingA11y = HEADING_A11Y.get(variant ?? 'default');
  const classes = cn(
    textVariants({ variant }),
    variant === 'eyebrow' && !(isRTL && isRtlScript) && EYEBROW_LATIN_DISPLAY,
    textClass,
    className
  );
  return (
    <Component
      className={isRtlScript ? withoutMonoFamily(classes) : classes}
      role={headingA11y?.role}
      aria-level={headingA11y?.level}
      {...props}
      maxFontSizeMultiplier={fontScaleCap ?? props.maxFontSizeMultiplier}
      style={
        isRTL || resetsTracking
          ? [
              isRTL ? RTL_WRITING_DIRECTION : undefined,
              resetsTracking ? NATURAL_LETTER_SPACING : undefined,
              props.style,
            ]
          : props.style
      }
    />
  );
}

export { Text, TextClassContext };
