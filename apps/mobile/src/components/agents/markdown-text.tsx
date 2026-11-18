import { useMemo, useRef } from 'react';
import { View } from 'react-native';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';

import { MarkdownCodeFence } from './markdown-code-fence';
import { MarkdownEnriched } from './markdown-enriched';
import { splitMarkdownFences } from './markdown-fences';
import {
  type MarkdownCopyCodeHandler,
  type MarkdownLinkLongPressHandler,
  type MarkdownLinkPressHandler,
} from './markdown-handlers';
import { convertHtmlToMarkdown } from './markdown-html-convert';
import {
  MarkdownHtml,
  type MarkdownHtmlIncrementalConverted,
  type MarkdownHtmlIncrementalInput,
  splitMarkdownHtmlIncremental,
} from './markdown-html';
import { MarkdownMermaid } from './markdown-mermaid';
import { getPalette, type MarkdownPalette, type MarkdownVariant } from './markdown-palette';
import { markdownHtmlSplitCache } from './markdown-parse-cache';

/**
 * The splitter input one publish passes: the extends-previous record's shape
 * picks the reuse form, and a declined or absent record re-converts the whole
 * value beside the previous snapshot so the head reuse still applies.
 */
export function incrementalInput(
  value: string,
  record: TailRecord | null,
  prior: MarkdownHtmlIncrementalConverted | undefined
): MarkdownHtmlIncrementalInput {
  if (record !== null && prior !== undefined && record.appended !== undefined) {
    return { value, previous: prior, appended: record.appended };
  }
  if (record !== null && prior !== undefined && record.wholeConverted !== undefined) {
    return { value, previous: prior, wholeConverted: record.wholeConverted };
  }
  return { value: convertHtmlToMarkdown(value), snapshot: prior?.tail };
}

/**
 * The offset where the raw value's final blank-line run begins, or null when
 * the value does not end with one. A blank line ends every open block: a
 * paragraph (including any inline tag it holds, which the conversion closed at
 * the line end), a fence, a code span, a list, and a quote are all finalized
 * behind it, so the appended region starts a fresh block and converting it
 * alone cannot rewrite the converted prefix. A value that ends inside a line
 * (mid-word, mid-tag, or with a lone newline a lazy continuation can join)
 * has no such boundary and must not compose.
 */
const TRAILING_BLANK_RUN = /(?:[ \t]*\r?\n)+$/;
function trailingBlankRunBoundary(rawValue: string): number | null {
  const run = TRAILING_BLANK_RUN.exec(rawValue);
  if (run === null) {
    return null;
  }
  const newlines = run[0].split('\n').length - 1;
  // One newline only ends the current line; a lazy continuation can join it,
  // so a full blank line (two or more newlines) is required.
  return newlines >= 2 ? run.index : null;
}

export type TailRecord =
  | {
      appended: string;
      wholeConverted?: undefined;
    }
  | { appended?: undefined; wholeConverted: string };

/**
 * Whether `value` extends `prior`'s raw value, and what the publish passes to
 * the splitter: when it does, the appended raw region, re-verified by
 * re-converting from the last stable raw boundary and comparing with the
 * previous publish's converted source; otherwise nothing, with the whole
 * value re-converted and the previous snapshot passed for head reuse.
 */
export function extendsPreviousRaw(
  value: string,
  prior: MarkdownHtmlIncrementalConverted | undefined
): TailRecord | null {
  if (prior === undefined) {
    return null;
  }
  const rawValue = prior.rawValue;
  if (rawValue === undefined || !value.startsWith(rawValue) || value.length === rawValue.length) {
    return null;
  }
  const appended = value.slice(rawValue.length);
  // The appended region alone can rewrite the converted prefix: an unclosed
  // code span or fence runs to the new end, an inline tag closes there.
  // Composition joins the previous converted source with the appended
  // region's own conversion, so it is sound only when the previous raw value
  // ended at a blank-line run: there every earlier construct is finalized and
  // the appended region starts a fresh block. A value still open at its end
  // (an unclosed inline tag, fence, or code span) can convert the appended
  // content differently from the whole value, so it declines.
  const rawBoundary = trailingBlankRunBoundary(rawValue);
  if (rawBoundary === null) {
    return { wholeConverted: convertHtmlToMarkdown(value) };
  }
  const previousConvertedTail = prior.convert(rawValue.slice(rawBoundary), '');
  const reconverted = convertHtmlToMarkdown(value.slice(rawBoundary));
  // `previousConvertedTail` recomputes the previous publish's conversion of
  // the finalized region from the same boundary; if the conversion that also
  // covers the appended content no longer starts with it, the append rewrote
  // that region (an unclosed code span or fence now runs further, an inline
  // tag closes at the new end) and the whole value is converted instead.
  if (!reconverted.startsWith(previousConvertedTail)) {
    return { wholeConverted: convertHtmlToMarkdown(value) };
  }
  return { appended };
}

export type MarkdownTextProps = {
  value: string;
  variant?: MarkdownVariant;
  /**
   * Base direction of the document body, when it has one of its own: a legal
   * document is English in every interface language, so its prose keeps a
   * left-to-right base direction and the left edge while the screen around it
   * mirrors. Chat omits this and follows the interface.
   */
  documentDirection?: 'ltr';
  selectable?: boolean;
  onLongPressLink?: MarkdownLinkLongPressHandler;
  /**
   * Optional tap handler invoked when a rendered link is pressed. When this
   * callback is omitted, or when it returns a falsy value, the renderer runs
   * the default confirm-and-open flow. Returning `true` signals that the
   * caller has fully handled the press and the default open should be skipped.
   */
  onPressLink?: MarkdownLinkPressHandler;
  /**
   * Optional handler that hands a rendered code fence's source to the caller.
   * A fence this renderer draws always offers copy; without a handler the
   * button copies through the shared clipboard helper. A fence left on the
   * native renderer's path (indented into a list or a blockquote) shows its
   * own copy button only when this handler is supplied.
   */
  onCopyCode?: MarkdownCopyCodeHandler;
};

export function MarkdownText({
  value,
  variant = 'assistant',
  documentDirection,
  selectable = true,
  onLongPressLink,
  onPressLink,
  onCopyCode,
}: Readonly<MarkdownTextProps>) {
  const colors = useThemeColors();

  const palette = useMemo(() => getPalette(variant, colors), [variant, colors]);

  // Re-lex only past the previous snapshot's tail boundary (its last block run
  // and any list or blockquote that can still absorb it): a streaming append can
  // only change that region, so the head segments (and the elements keyed by
  // index) stay stable while the message grows. The memo keeps an unrelated
  // re-render from re-lexing an unchanged value; the ref survives it so the
  // next value still extends the snapshot. The split inherits the previous
  // split's converted markdown and converts only the appended region, so the
  // conversion step is tail-bounded like the lexing step.
  const previousRef = useRef<MarkdownHtmlIncrementalConverted | undefined>(undefined);
  const { segments } = useMemo(() => {
    // A remount (a FlashList row re-entering the window) starts without a
    // previous publish, so the parser can only rebuild the whole value.
    // Completed values were cached on the previous mount — including the last
    // streaming publish, which is the value a remount sees — so reuse that
    // parse instead of lexing and segmenting the same source again.
    const cached =
      previousRef.current === undefined ? markdownHtmlSplitCache.get(value) : undefined;
    if (cached !== undefined) {
      return cached;
    }
    const prior = previousRef.current;
    // The split inherits the previous publish's work only when the value
    // extends exactly what the previous publish's raw value was: the guard
    // compares raw to raw, since the converted tail re-closes streamed tags
    // and no longer equals the raw source. When it engages, the previous
    // converted source is reproduced from a raw region whose earlier
    // constructs are all finalized (the last blank-line boundary), verified by
    // string comparison against the previous publish, so a construct whose
    // masking or closing spans the boundary (an unclosed code span or fence,
    // an inline tag the new end closes) falls back to converting the whole
    // value.
    const record = extendsPreviousRaw(value, prior);
    const input = incrementalInput(value, record, prior);
    const result = splitMarkdownHtmlIncremental(input);
    markdownHtmlSplitCache.set(value, result);
    previousRef.current = {
      tail: result.snapshot,
      rawValue: value,
      convert: (suffix, previous) =>
        suffix === '' ? previous : `${previous}${convertHtmlToMarkdown(suffix)}`,
    };
    return result;
  }, [value]);

  // Always render through the same wrapping View with index keys: switching to
  // a bare markdown element when no HTML token exists would change the root
  // element type, remounting the markdown prefix as soon as the first HTML
  // token streams in.
  return (
    <View>
      {segments.map((segment, index) =>
        segment.type === 'html' ? (
          <MarkdownHtml
            key={`md-html-${index}`}
            html={segment.raw}
            palette={palette}
            documentDirection={documentDirection}
            selectable={selectable}
            onLongPressLink={onLongPressLink}
            onPressLink={onPressLink}
          />
        ) : (
          <MarkdownRun
            key={`md-content-${index}`}
            raw={segment.raw}
            palette={palette}
            documentDirection={documentDirection}
            selectable={selectable}
            onLongPressLink={onLongPressLink}
            onPressLink={onPressLink}
            onCopyCode={onCopyCode}
          />
        )
      )}
    </View>
  );
}

type MarkdownRunProps = {
  raw: string;
  palette: MarkdownPalette;
  documentDirection?: 'ltr';
  selectable: boolean;
  onLongPressLink?: MarkdownLinkLongPressHandler;
  onPressLink?: MarkdownLinkPressHandler;
  onCopyCode?: MarkdownCopyCodeHandler;
};

/**
 * One markdown run: its fenced code blocks are drawn by this app (wrapping, so
 * a long line stays readable inside the bubble) and everything between them by
 * the native renderer. A mermaid fence keeps the diagram renderer once it is
 * closed; while a streamed append is still open the source shows as code, as the
 * fence regex it replaces did.
 */
function MarkdownRun({
  raw,
  palette,
  documentDirection,
  selectable,
  onLongPressLink,
  onPressLink,
  onCopyCode,
}: Readonly<MarkdownRunProps>) {
  const runs = useMemo(() => splitMarkdownFences(raw), [raw]);
  return (
    <>
      {runs.map((run, index) => {
        if (run.type === 'text') {
          return (
            <MarkdownEnriched
              key={`md-text-${index}`}
              value={run.raw}
              palette={palette}
              documentDirection={documentDirection}
              selectable={selectable}
              onLongPressLink={onLongPressLink}
              onPressLink={onPressLink}
              onCopyCode={onCopyCode}
            />
          );
        }
        return run.language === 'mermaid' && run.closed ? (
          <MarkdownMermaid
            key={`md-fence-${index}`}
            source={run.code}
            palette={palette}
            selectable={selectable}
            onCopyCode={onCopyCode}
          />
        ) : (
          <MarkdownCodeFence
            key={`md-fence-${index}`}
            code={run.code}
            language={run.language}
            palette={palette}
            selectable={selectable}
            onCopyCode={onCopyCode}
          />
        );
      })}
    </>
  );
}
