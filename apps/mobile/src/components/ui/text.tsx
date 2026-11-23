import * as Slot from '@rn-primitives/slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { I18nManager, Text as RNText, type Role, type TextStyle } from 'react-native';

import { useSystemFontScale } from '@/lib/font-scale/system-font-scale-context';
import { resolveFontScaleCap } from '@/lib/font-scale/text-scale-cap';

import {
  containsJoinedScript,
  contentTextDirection,
  hasRtlScript,
  keepsLatinDisplay,
  NATURAL_LETTER_SPACING,
  pinsTextDirection,
  RTL_WRITING_DIRECTION,
  rtlBaseMarkedChildren,
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
 * on full capitals and letterspacing, and an Arabic-script label can take
 * neither: its tracking is reset (`NATURAL_LETTER_SPACING`) and its capitals do
 * not exist, so without them the label kept only the 10px size — measured in an
 * Arabic interface, `الفواتير` inked 25.9 x 9.14 dp against the Latin
 * `FATURAS`' 50.67 x 7.62 dp. The script takes the line's height and stroke
 * weight from the size instead; 13px is the size whose line box matches the
 * Latin capitals' cap height. The script is the copy's, not the interface's,
 * exactly like `withoutMonoFamily`. Kept in step with the reserved eyebrow twin
 * in `screen-header.tsx`, which holds this same line box before the label
 * arrives. The Brahmic and Southeast Asian scripts in `JOINED_SCRIPT` lose the
 * tracking but keep the 10px size: their stacked vowel signs already ink taller
 * than the Latin capitals (a Tamil eyebrow inked 12.19 dp tall at 10px).
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
 * dp at scale 1 and the native pipeline carries it to the live scale once
 * (pre-scaling it as well would apply the system scale twice; see
 * `use-text-height.tsx`, `scaledLineHeight`).
 */
export const EYEBROW_LINE_HEIGHT_DP = 22;

const TextClassContext = React.createContext<string | undefined>(undefined);

function Text({
  className,
  asChild = false,
  variant = 'default',
  direction,
  ...props
}: React.ComponentProps<typeof RNText> &
  TextVariantProps & {
    asChild?: boolean;
    /**
     * The paragraph's base direction. App copy omits it and names the
     * interface's. `auto` is for copy the app did not write — a server's
     * message, a finding's description, a user's own text — which names its
     * own direction, and the node's layout with it, so English content keeps
     * its left edge and the punctuation that ends it inside a right-to-left
     * interface (`contentTextDirection`).
     */
    direction?: 'auto';
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
      // draws the glyphs of neither the right-to-left blocks (`RTL_SCRIPT`) nor
      // the joined scripts (`JOINED_SCRIPT`), so copy in either set drops the
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
  const eyebrowLineHeight: TextStyle | undefined =
    variant === 'eyebrow' ? { lineHeight: EYEBROW_LINE_HEIGHT_DP } : undefined;
  const headingA11y = HEADING_A11Y.get(variant ?? 'default');
  const classes = cn(
    textVariants({ variant }),
    variant === 'eyebrow' && keepsLatinDisplay(isRtlScript) && EYEBROW_LATIN_DISPLAY,
    // `cn` merges last-wins, so the script's 13px replaces the variant's 10px
    // and a caller's own `text-*` still has the final word after it.
    variant === 'eyebrow' && isRtlScript && EYEBROW_RTL_SCRIPT_DISPLAY,
    textClass,
    className
  );
  const interfaceDirection: TextStyle | undefined = isRTL ? RTL_WRITING_DIRECTION : undefined;
  const writingDirection =
    direction === 'auto'
      ? (contentTextDirection(props.children) ?? interfaceDirection)
      : interfaceDirection;
  // A style direction does not move the paragraph itself: React Native never
  // sets a text view's own direction, and Android resolves a paragraph from its
  // first strong character, so app copy that opens on a Latin product name
  // needs a right-to-left mark in front of it (`rtlBaseMarkedChildren`).
  // Content names its own first letter's direction and gets no mark; `asChild`
  // passes one element child through, which `Slot.Text` takes unchanged
  // (`asChild` has no call site in the app today); and a caller that names a
  // base direction of its own — a path, a command, an identifier pinned with
  // `LTR_TEXT_DIRECTION` — has said what that direction is, so its copy keeps
  // the base direction it asked for (`pinsTextDirection`).
  //
  // Cached against the child tree, the caller's style and the script flag the
  // scan above already computed, so a re-render with unchanged props reads no
  // character of the copy.
  const renderedChildren = React.useMemo(() => {
    if (asChild || direction === 'auto' || pinsTextDirection(props.style)) {
      return props.children;
    }
    return rtlBaseMarkedChildren(props.children, isRtlScript);
  }, [asChild, direction, isRtlScript, props.children, props.style]);
  // The direction and reset land in the same array the component has always
  // built, so a non-eyebrow text node's style never grows an empty entry; the
  // eyebrow's line box leads its own array, before `props.style`, so a caller's
  // `lineHeight` still wins (`ownStyles` reads the last entry).
  const directionStyle =
    writingDirection !== undefined || resetsTracking
      ? [writingDirection, resetsTracking ? NATURAL_LETTER_SPACING : undefined, props.style]
      : props.style;
  const resolvedStyle = eyebrowLineHeight
    ? [
        eyebrowLineHeight,
        writingDirection,
        resetsTracking ? NATURAL_LETTER_SPACING : undefined,
        props.style,
      ]
    : directionStyle;
  // The mono family is dropped for both sets of copy it cannot draw: the
  // right-to-left blocks (`isRtlScript`, `RTL_SCRIPT`) and the joined scripts
  // (`joinedScript`, `JOINED_SCRIPT`). Either way a fallback would set the copy
  // glyph by glyph and lose its joins or clusters, so the family goes in both
  // interface directions and only the size, color and weight classes stay.
  const dropsMonoFamily = isRtlScript || joinedScript;
  return (
    <Component
      className={dropsMonoFamily ? withoutMonoFamily(classes) : classes}
      role={headingA11y?.role}
      aria-level={headingA11y?.level}
      {...props}
      maxFontSizeMultiplier={fontScaleCap ?? props.maxFontSizeMultiplier}
      style={resolvedStyle}
    >
      {renderedChildren}
    </Component>
  );
}

export { Text, TextClassContext };
