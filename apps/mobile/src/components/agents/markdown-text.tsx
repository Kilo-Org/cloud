import { useEffect, useMemo, useRef } from 'react';
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
import { convertHtmlToMarkdown, convertHtmlToMarkdownWithTail } from './markdown-html-convert';
import {
  MarkdownHtml,
  type MarkdownHtmlConversionTail,
  type MarkdownHtmlIncrementalConverted,
  type MarkdownHtmlIncrementalInput,
  type MarkdownHtmlSegment,
  splitMarkdownHtmlIncremental,
} from './markdown-html';
import { MarkdownMermaid } from './markdown-mermaid';
import { getPalette, type MarkdownPalette, type MarkdownVariant } from './markdown-palette';
import { type CachedMarkdownHtmlSplit, markdownHtmlSplitCache } from './markdown-parse-cache';

/**
 * The tail of the conversion of `value` that starts its open region at `start`.
 */
function conversionTailFrom(value: string, start: number): MarkdownHtmlConversionTail {
  return { start, converted: start === 0 ? '' : convertHtmlToMarkdown(value.slice(start)) };
}

/** One whole conversion's markdown and the tail the next publish reuses. */
type WholeConversion = { markdown: string; tail: MarkdownHtmlConversionTail };

/** One whole conversion plus the tail the next publish reuses, from one scan. */
function wholeConversion(value: string): WholeConversion {
  const { markdown, tailStart } = convertHtmlToMarkdownWithTail(value);
  return { markdown, tail: conversionTailFrom(value, tailStart) };
}

/**
 * One publish's connection to the previous one: `appended` is the raw region
 * the value grew by, which the splitter folds through the previous conversion,
 * and `wholeConverted` is the whole value's conversion when the composition
 * could not be reproduced exactly. Both carry the tail the publish's own
 * conversion found, so the next publish never converts that region again.
 */
export type TailRecord =
  | { mode: 'appended'; appended: string; conversion: MarkdownHtmlConversionTail }
  | { mode: 'whole'; wholeConverted: string; conversion: MarkdownHtmlConversionTail };

/**
 * What one publish hands its effect: the segments to render, and the seed the
 * effect installs — the cached/derived split keyed by its raw value plus the
 * previous-publish record the next publish reuses.
 */
type PublishSeed = {
  rawValue: string;
  split: CachedMarkdownHtmlSplit;
  record: MarkdownHtmlIncrementalConverted;
};

/**
 * The previous-publish record the next publish reuses: the split's snapshot as
 * the tail, the raw value the split segmented, the tail the publish carried,
 * and the conversion closure that folds an appended region after the previous
 * converted source. The cache-hit and miss paths build it over the same shape,
 * so a remounted row that reuses a cached split still extends it instead of
 * re-converting whole.
 */
function buildTailRecord(rawValue: string, split: CachedMarkdownHtmlSplit): PublishSeed {
  return {
    rawValue,
    split,
    record: {
      tail: split.snapshot,
      rawValue,
      conversion: split.conversion,
      convert: (suffix, previous) =>
        suffix === '' ? previous : `${previous}${convertHtmlToMarkdown(suffix)}`,
    },
  };
}

// A root construct whose conversion reads what precedes it: a markdown block
// needs its blank line before it and a `<br>` needs the text before it on its
// line, so a region that begins with one does not convert the way it does in
// place.
const LEADING_ROOT = /^\s*<(?:p|h[1-6]|blockquote|ul|ol|pre|hr|table|br)[\s/>]/i;
// A line indented enough to be code: code at the start of a value, but the
// continuation of a paragraph directly above it.
const INDENTED_LINE = /^(?: {4}|\t| {1,3}\t)/;

/** The start of the line above the one that starts at `at`. */
function previousLineStart(value: string, at: number): number {
  return at <= 1 ? 0 : value.lastIndexOf('\n', at - 2) + 1;
}

/** The record for a publish whose composition the gate declined: one whole conversion. */
function declined(value: string): TailRecord {
  const { markdown, tail } = wholeConversion(value);
  return { mode: 'whole', wholeConverted: markdown, conversion: tail };
}

/**
 * Whether `value` extends `prior`'s raw value, and what the publish passes to
 * the splitter: when it does, the appended raw region, verified by reproducing
 * the previous publish's conversion of the open region exactly, plus the tail
 * its own conversion found; otherwise the whole value converted exactly once,
 * carrying its tail so the next publish never converts it again.
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
  const conversion = prior.conversion;
  if (conversion === undefined || conversion.start === 0) {
    return declined(value);
  }
  const boundary = conversion.start;
  const converted = prior.tail.value;
  if (boundary >= rawValue.length) {
    // Every byte of the previous conversion is final. The appended text starts
    // on a fresh line, so only a construct that reads what precedes it can
    // convert differently here than alone: a root block needs its blank line
    // and a `<br>` the text before it, an indented line continues a paragraph,
    // and an inline construct reads the character before it, which has to stay
    // a line break.
    if (LEADING_ROOT.test(appended) || INDENTED_LINE.test(appended) || !converted.endsWith('\n')) {
      return declined(value);
    }
    const appendedConverted = convertHtmlToMarkdown(appended);
    if (appendedConverted.startsWith('\n')) {
      // The isolated conversion inserted a block separator because its own
      // output was still empty, while in place the previous text already ends
      // the block. Join the last line and the append and require the same
      // conversion as that region in the value, so the composed string stays
      // byte-identical to the whole conversion.
      const anchor = previousLineStart(rawValue, rawValue.length);
      if (
        `${convertHtmlToMarkdown(rawValue.slice(anchor))}${appendedConverted}` !==
        convertHtmlToMarkdown(value.slice(anchor))
      ) {
        return declined(value);
      }
    }
    // The appended text is the only region that can still change, so its own
    // open region — offset by where it begins — is the whole value's. Scanning
    // it keeps that region at the appended size: a later publish that extends a
    // blank-line-terminated append then re-opens only its own text instead of
    // the growing run behind it.
    const appendedTail = convertHtmlToMarkdownWithTail(appended);
    const tailSource = appended.slice(appendedTail.tailStart);
    return {
      mode: 'appended',
      appended,
      conversion: {
        start: rawValue.length + appendedTail.tailStart,
        converted: convertHtmlToMarkdown(tailSource),
      },
    };
  }
  // A whitespace run collapses across the seam: a trailing space and a leading
  // space convert to one space together, so the two regions do not compose.
  if (/\s$/.test(rawValue) && /^\s/.test(appended)) {
    return declined(value);
  }
  const region = value.slice(boundary);
  if (LEADING_ROOT.test(region) || LEADING_ROOT.test(appended)) {
    return declined(value);
  }
  // An indented first line below anything but a blank line continues that
  // line's paragraph instead of starting code, so the region reads it as the
  // value does not.
  if (
    INDENTED_LINE.test(region) &&
    !/^[ \t]*$/.test(rawValue.slice(previousLineStart(rawValue, boundary), boundary))
  ) {
    return declined(value);
  }
  // The previous publish's conversion of this region, and the same region with
  // the appended text. Composition holds only when appending the region's
  // conversion reproduces the region's new conversion exactly: an unclosed code
  // span or fence now runs further, an inline tag closes at the new end, and the
  // region converts differently from the whole value. The record's tail is the
  // previous publish's own conversion of that region, so this costs one region
  // conversion.
  const previousTail = conversion.converted;
  if (previousTail === '' || !converted.endsWith(previousTail)) {
    return declined(value);
  }
  const reconverted = convertHtmlToMarkdown(region);
  if (`${previousTail}${convertHtmlToMarkdown(appended)}` !== reconverted) {
    return declined(value);
  }
  // `reconverted` is this region's conversion, so the next publish's gate can
  // reproduce the previous conversion without converting the region again.
  return { mode: 'appended', appended, conversion: { start: boundary, converted: reconverted } };
}

/**
 * One publish's conversion: the splitter input it passes, and the tail its own
 * conversion found — where that conversion stops being final, and that region's
 * conversion.
 */
export type PublishConversion = {
  input: MarkdownHtmlIncrementalInput;
  tail: MarkdownHtmlConversionTail;
};

/**
 * The publish's conversion and its tail. A gated publish passes the tail its
 * record already carries, so it converts only the regions the gate compared;
 * a declined or first publish converts the whole value exactly once and carries
 * the tail that conversion found.
 */
export function publishConversion(
  value: string,
  record: TailRecord | null,
  prior: MarkdownHtmlIncrementalConverted | undefined
): PublishConversion {
  if (record === null || prior === undefined) {
    const { markdown, tail } = wholeConversion(value);
    return {
      input: prior === undefined ? { value: markdown } : { value: markdown, snapshot: prior.tail },
      tail,
    };
  }
  return {
    input:
      record.mode === 'appended'
        ? { value, previous: prior, appended: record.appended }
        : { value, previous: prior, wholeConverted: record.wholeConverted },
    tail: record.conversion,
  };
}

export type MarkdownTextProps = {
  value: string;
  variant?: MarkdownVariant;
  /**
   * Base direction of the document body, when it has one of its own: a legal
   * document is English in every interface language, so its prose keeps a
   * left-to-right base direction and the left edge while the screen around it
   * mirrors. Chat and every other content body omit this: each paragraph then
   * resolves from its own first strong character, so English content keeps its
   * left edge and Arabic content sits on the right in either interface.
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
  // next value still extends the snapshot. The conversion is bounded by the
  // open region the previous publish reported, not by the message: a gated
  // publish converts the appended region and the open region alone. A declined
  // publish, and the first publish of a mount, convert the whole value exactly
  // once and carry the tail that conversion found, so no publish converts the
  // whole value twice.
  const previousRef = useRef<MarkdownHtmlIncrementalConverted | undefined>(undefined);
  const publish = useMemo<{
    segments: MarkdownHtmlSegment[];
    seed: PublishSeed;
  }>(() => {
    // A remount (a FlashList row re-entering the window) starts without a
    // previous publish, so the parser can only rebuild the whole value.
    // Completed values were cached on the previous mount — including the last
    // streaming publish, which is the value a remount sees — so reuse that
    // parse instead of lexing and segmenting the same source again, and seed
    // the previous-publish record from the cache so the next value still
    // extends the remounted row's snapshot instead of re-converting whole.
    const cached =
      previousRef.current === undefined ? markdownHtmlSplitCache.get(value) : undefined;
    if (cached !== undefined) {
      return { segments: cached.segments, seed: buildTailRecord(value, cached) };
    }
    const prior = previousRef.current;
    // The split inherits the previous publish's work only when the value
    // extends exactly what the previous publish's raw value was: the guard
    // compares raw to raw, since the converted tail re-closes streamed tags
    // and no longer equals the raw source. When it engages, the previous
    // converted source is reproduced from the previous publish's own
    // conversion of the still-open raw region, and the composition is accepted
    // only when that region plus the appended text converts byte for byte to
    // the same markdown: a construct whose masking or closing spans the
    // boundary (an unclosed code span or fence, an inline tag the new end
    // closes) falls back to converting the whole value.
    const record = extendsPreviousRaw(value, prior);
    const conversion = publishConversion(value, record, prior);
    const result = splitMarkdownHtmlIncremental(conversion.input);
    const split: CachedMarkdownHtmlSplit = {
      segments: result.segments,
      snapshot: result.snapshot,
      conversion: conversion.tail,
    };
    return { segments: result.segments, seed: buildTailRecord(value, split) };
  }, [value]);

  // The record the next publish reuses is written after render, so a render
  // React discards never installs it, and the cache keeps completed values
  // across remounts. Both derive from the memoized result alone.
  useEffect(() => {
    const seed = publish.seed;
    markdownHtmlSplitCache.set(seed.rawValue, seed.split);
    previousRef.current = seed.record;
    // `publish` changes only when the memo recomputed for a new value; an
    // unrelated re-render reuses the same object and skips the write.
  }, [publish]);

  // Always render through the same wrapping View with index keys: switching to
  // a bare markdown element when no HTML token exists would change the root
  // element type, remounting the markdown prefix as soon as the first HTML
  // token streams in.
  return (
    <View>
      {publish.segments.map((segment, index) =>
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
