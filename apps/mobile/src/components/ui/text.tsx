import * as Slot from '@rn-primitives/slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { I18nManager, Text as RNText, type Role, type TextStyle } from 'react-native';

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
      h2: 'border-border border-b pb-2 text-3xl font-semibold tracking-tight',
      h3: 'text-2xl font-semibold tracking-tight',
      large: 'text-lg font-semibold',
      heading: 'text-base font-semibold',
      small: 'text-sm font-medium leading-none',
      figure: 'text-2xl font-bold tabular-nums',
      // A half-width stat tile's number: one step under `figure`, and still
      // tabular so two tiles' digits line up down the row.
      stat: 'text-lg font-bold tabular-nums',
      muted: 'text-muted-foreground text-sm',
      caption: 'text-xs text-muted-foreground',
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
  ['h2', { role: 'heading', level: '2' }],
  ['h3', { role: 'heading', level: '3' }],
  ['heading', { role: 'heading', level: '2' }],
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

/**
 * The RTL-script twin of the eyebrow's size. The Latin display treatment leans
 * on full capitals and letterspacing, and a joined/Arabic-script label can take
 * neither: its tracking is reset (`NATURAL_LETTER_SPACING`) and its capitals do
 * not exist, so without them the label kept only the 10px size — measured in an
 * Arabic interface, `الفواتير` inked 25.9 x 9.14 dp against the Latin
 * `FATURAS`' 50.67 x 7.62 dp. The script takes the line's height and stroke
 * weight from the size instead; 13px is the size whose line box matches the
 * Latin capitals' cap height. The script is the copy's, not the interface's,
 * exactly like `withoutMonoFamily`. Kept in step with the reserved eyebrow twin
 * in `screen-header.tsx`, which holds this same line box before the label
 * arrives.
 */
export const EYEBROW_RTL_SCRIPT_DISPLAY = 'text-[13px]';

/**
 * The eyebrow's line box in dp, at font scale 1, for every script. Measured on
 * the design-gate device: an RTL-script eyebrow at 13px took a 22.48 dp box
 * there, while the 10px Latin eyebrow took 14.1 dp — a difference that moves the
 * header when the two swap places. `screen-header.tsx`'s reserve holds this box
 * before the label arrives and can never know that label's script, so the box
 * must not depend on it: one explicit height, and both sizes sit inside it.
 * Emitted unscaled: React Native multiplies an explicit `lineHeight` by the
 * system font scale itself, bounded by `maxFontSizeMultiplier`, so this is the
 * dp at scale 1 and the native pipeline carries it to the live scale once.
 */
export const EYEBROW_LINE_HEIGHT_DP = 22;

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
  // One line box for the eyebrow in every script: the reserve in
  // `screen-header.tsx` can never know the arriving label's script, so the box
  // must not depend on it, and the 10px Latin size and the 13px RTL-script twin
  // both sit inside `EYEBROW_LINE_HEIGHT_DP`. The value stays at font scale 1
  // here: React Native scales an explicit `lineHeight` through the native text
  // pipeline exactly as it scales the font size, bounded by the same
  // `maxFontSizeMultiplier`, so pre-scaling it as well would apply the system
  // scale twice (`use-text-height.tsx`, `scaledLineHeight`). A caller's own
  // `lineHeight` still wins: the computed entry comes before `props.style`.
  const eyebrowLineHeight: TextStyle | undefined =
    variant === 'eyebrow' ? { lineHeight: EYEBROW_LINE_HEIGHT_DP } : undefined;
  const headingA11y = HEADING_A11Y.get(variant ?? 'default');
  const classes = cn(
    textVariants({ variant }),
    variant === 'eyebrow' && !(isRTL && isRtlScript) && EYEBROW_LATIN_DISPLAY,
    // `cn` merges last-wins, so the script's 13px replaces the variant's 10px
    // and a caller's own `text-*` still has the final word after it.
    variant === 'eyebrow' && isRtlScript && EYEBROW_RTL_SCRIPT_DISPLAY,
    textClass,
    className
  );
  // The direction and reset land in the same array the component has always
  // built, so a non-eyebrow text node's style never grows an empty entry; the
  // eyebrow's line box leads its own array, before `props.style`, so a caller's
  // `lineHeight` still wins (`ownStyles` reads the last entry).
  const directionStyle =
    isRTL || resetsTracking
      ? [
          isRTL ? RTL_WRITING_DIRECTION : undefined,
          resetsTracking ? NATURAL_LETTER_SPACING : undefined,
          props.style,
        ]
      : props.style;
  const resolvedStyle = eyebrowLineHeight
    ? [
        eyebrowLineHeight,
        isRTL ? RTL_WRITING_DIRECTION : undefined,
        resetsTracking ? NATURAL_LETTER_SPACING : undefined,
        props.style,
      ]
    : directionStyle;
  return (
    <Component
      className={isRtlScript ? withoutMonoFamily(classes) : classes}
      role={headingA11y?.role}
      aria-level={headingA11y?.level}
      {...props}
      maxFontSizeMultiplier={fontScaleCap ?? props.maxFontSizeMultiplier}
      style={resolvedStyle}
    />
  );
}

export { Text, TextClassContext };
