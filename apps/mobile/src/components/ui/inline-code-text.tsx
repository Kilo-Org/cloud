import { type ReactNode } from 'react';
import { Text as RNText } from 'react-native';

import { Text } from '@/components/ui/text';

/**
 * Renders locale copy that carries markdown-style `` `inline code` `` spans as
 * real inline code: each backtick-delimited span becomes a marked code run
 * nested inside the surrounding text, and no backtick character ever reaches
 * the screen. The span inherits the wrapping text's font family and size, so
 * a hint at `text-xs` and a body at `text-base` both keep their line metrics
 * (nested-text vertical padding would shift line boxes in wrapped copy).
 *
 * Deliberately no mono font swap: JetBrains Mono draws every glyph — the space
 * included — at a fixed 0.6em advance, more than double the surrounding
 * proportional text's word space, so a multi-word command ("kilo remote")
 * read as "kilo  remote" with a loose gap (spot check, e7-welcome/
 * e8-tour-open/e18-tour-open). The word gap renders at exactly the body
 * text's width; only the mark changes.
 *
 * The mark is text color and weight — never a background. A nested Text has
 * no chip on device: `rounded`/`px` do not apply to nested runs, and its
 * background is not a tag either. Android paints a nested run's background
 * with `BackgroundColorSpan` (react-native TextLayoutManager.kt:455) — a
 * full-line-height, square-cornered rectangle flush to the glyphs, the very
 * span text selection uses — and iOS ignores nested-run backgrounds entirely
 * (RCTTextShadowView.mm:47). So any background token, however far from the
 * page color, renders as a selection wash on Android (spot check e1-welcome:
 * `bg-muted` and then `bg-muted-soft` were both reported as "a pale unmarked
 * wash that reads as a leftover text selection" — the shape is the defect,
 * and no token choice fixes it). `text-primary font-semibold` is the mark a
 * nested Text genuinely renders on both platforms: the run reads as a
 * deliberate accent token with no rectangle behind it to misread.
 *
 * A string without a matched pair falls through as plain text, so a stray or
 * unbalanced backtick can never render as raw markup soup.
 */

/** Splits `"a `b` c"` into `["a ", "b", " c"]` — odd indices are code spans. */
const INLINE_CODE_SPANS = /`([^`]+)`/g;
const HAS_CODE_SPAN = /`[^`]+`/;

const INLINE_CODE_CLASS = 'text-primary font-semibold';

/**
 * A breakable space inside the span lets Android wrap the run mid-command,
 * splitting `kilo remote` across two lines so the marked token no longer
 * reads as one command. A non-breaking space is not a line-break opportunity:
 * the span stays one fragment. In the inherited body font NBSP carries the
 * same advance as a real space, so the gap stays as tight as the surrounding
 * text. The catalog keeps the real space; this is a display-only transform.
 */
function asUnbreakableCodeSpan(span: string): string {
  return span.replaceAll(' ', '\u00A0');
}

export type InlineCodeTextProps = {
  /** Copy that may carry `inline code` spans. */
  children: string;
  /** Variant for the wrapping text (e.g. `muted` for empty-state copy). */
  variant?: React.ComponentProps<typeof Text>['variant'];
  className?: string;
};

export function InlineCodeText({ children, variant, className }: InlineCodeTextProps) {
  if (!HAS_CODE_SPAN.test(children)) {
    return (
      <Text variant={variant} className={className}>
        {children}
      </Text>
    );
  }
  const runs: ReactNode[] = [];
  let cursor = 0;
  for (const match of children.matchAll(INLINE_CODE_SPANS)) {
    const start = match.index;
    if (start > cursor) {
      runs.push(children.slice(cursor, start));
    }
    runs.push(
      // Bare RN Text on purpose: the styled Text's cva base
      // (`text-foreground text-base font-medium`) would override the
      // wrapper's size and color on this nested run, so the marked run
      // carries only its own classes and inherits everything else.
      <RNText key={`code-${runs.length}`} className={INLINE_CODE_CLASS}>
        {asUnbreakableCodeSpan(match[1] ?? '')}
      </RNText>
    );
    cursor = start + match[0].length;
  }
  if (cursor < children.length) {
    runs.push(children.slice(cursor));
  }
  return (
    <Text variant={variant} className={className}>
      {runs}
    </Text>
  );
}
