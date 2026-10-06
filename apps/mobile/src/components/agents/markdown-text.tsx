import { useEffect, useMemo, useRef, useState } from 'react';
import { type ColorSchemeName, useColorScheme, View } from 'react-native';
import { useMarkdown } from 'react-native-marked';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';

import {
  MarkdownHtml,
  type MarkdownHtmlSnapshot,
  splitMarkdownHtmlIncremental,
} from './markdown-html';
import { MarkdownMermaid } from './markdown-mermaid';
import { MarkdownEnriched } from './markdown-enriched';
import {
  getMarkdownStyles,
  getPalette,
  type MarkdownPalette,
  type MarkdownVariant,
} from './markdown-palette';
import {
  markdownHtmlSplitCache,
  markdownRenderCache,
  type MarkdownRenderEntry,
  markdownRenderKey,
  markdownTableSegmentsCache,
} from './markdown-parse-cache';
import {
  type MarkdownCodeLongPressHandler,
  type MarkdownCopyCodeHandler,
  type MarkdownLinkLongPressHandler,
  type MarkdownLinkPressHandler,
  MarkdownRenderer,
} from './markdown-renderer';
import { MarkdownTable } from './markdown-table';
import { type MarkdownSplitSegment, splitMarkdownTables } from './markdown-table-extract';

export type MarkdownTextProps = {
  value: string;
  variant?: MarkdownVariant;
  selectable?: boolean;
  /**
   * A stable identity for the host that supplied the interactive handlers, e.g.
   * a message id. The per-message handlers a host forwards close over that
   * message, so two messages with identical markdown must not share cached
   * render elements; this is the cache scope that keeps them apart while still
   * letting a remount of the same message reuse its parse. Omitted by static,
   * handler-free callers, which are safe to share by value alone.
   */
  renderScope?: string;
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
   * When omitted, fences render statically with no copy affordance.
   */
  onCopyCode?: MarkdownCopyCodeHandler;
  /**
   * Optional long-press handler for a code fence's copy trigger. Transcript
   * hosts forward their message-details long-press here so press-and-hold on a
   * fence still opens details. Ignored when `onCopyCode` is omitted.
   */
  onLongPressCode?: MarkdownCodeLongPressHandler;
};

export function MarkdownText({
  value,
  variant = 'assistant',
  selectable = true,
  renderScope,
  onLongPressLink,
  onPressLink,
  onCopyCode,
  onLongPressCode,
}: Readonly<MarkdownTextProps>) {
  const colors = useThemeColors();

  const palette = useMemo(() => getPalette(variant, colors), [variant, colors]);

  // Re-lex only past the previous snapshot's tail boundary (its last block run
  // and any list or blockquote that can still absorb it): a streaming append can
  // only change that region, so the head segments (and the MarkdownContent
  // instances keyed by index) stay stable while the message grows. The memo
  // keeps an unrelated re-render from re-lexing an unchanged value; the ref
  // survives it so the next value still extends the snapshot.
  const snapshotRef = useRef<MarkdownHtmlSnapshot | undefined>(undefined);
  const { segments, snapshot } = useMemo(() => {
    // A remount (a FlashList row re-entering the window) starts without a
    // snapshot, so the incremental parser can only rebuild the whole value.
    // Completed values were cached on the previous mount — including the last
    // streaming publish, which is the value a remount sees — so reuse that
    // parse instead of lexing and segmenting the same source again.
    const cached =
      snapshotRef.current === undefined ? markdownHtmlSplitCache.get(value) : undefined;
    const result = cached ?? splitMarkdownHtmlIncremental(value, snapshotRef.current);
    markdownHtmlSplitCache.set(value, result);
    return result;
  }, [value]);
  snapshotRef.current = snapshot;

  // Always render through the same wrapping View with index keys: switching to
  // a bare MarkdownContent when no HTML token exists would change the root
  // element type, remounting the markdown prefix (and wiping its table
  // snapshot and CodeBlock keys) as soon as the first HTML token streams in.
  return (
    <View>
      {segments.map((segment, index) =>
        segment.type === 'html' ? (
          <MarkdownHtml
            key={`md-html-${index}`}
            html={segment.raw}
            palette={palette}
            selectable={selectable}
            onLongPressLink={onLongPressLink}
            onPressLink={onPressLink}
          />
        ) : (
          splitMermaidFences(segment.raw).map((part, partIndex) =>
            part.type === 'mermaid' ? (
              <MarkdownMermaid
                key={`md-mermaid-${index}-${partIndex}`}
                source={part.raw}
                palette={palette}
              />
            ) : (
              <MarkdownEnriched
                key={`md-content-${index}-${partIndex}`}
                value={part.raw}
                palette={palette}
                selectable={selectable}
                onLongPressLink={onLongPressLink}
                onPressLink={onPressLink}
                onCopyCode={onCopyCode}
              />
            )
          )
        )
      )}
    </View>
  );
}

// A closed ```mermaid fence at the start of a line. An unclosed fence (still
// streaming) does not match, so it stays a code block until it closes.
const MERMAID_FENCE = /^```mermaid[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm;

function splitMermaidFences(raw: string): { type: 'markdown' | 'mermaid'; raw: string }[] {
  const parts: { type: 'markdown' | 'mermaid'; raw: string }[] = [];
  let last = 0;
  for (const match of raw.matchAll(MERMAID_FENCE)) {
    if (match.index > last) {
      parts.push({ type: 'markdown', raw: raw.slice(last, match.index) });
    }
    parts.push({ type: 'mermaid', raw: match[1] ?? '' });
    last = match.index + match[0].length;
  }
  if (last < raw.length || parts.length === 0) {
    parts.push({ type: 'markdown', raw: raw.slice(last) });
  }
  return parts;
}

type MarkdownContentProps = Omit<MarkdownTextProps, 'variant'> & {
  palette: MarkdownPalette;
};

// A GFM table needs a delimiter row: a line of `:?-+:?` cells. Pipes are not
// required by GFM: `a\n:-\nb` lexes as a table in the repo's marked, and a
// single-cell row (`| --- |`) is valid, so the row is recognized by a pipe or
// a colon. A pipe-less, colon-less run of dashes (`---`, `- - -`) is a setext
// underline or thematic break, not a table, and stays on the fast path.
// Without a match, `splitTableSegments` returns the value as a single markdown
// run, which is what `splitMarkdownTables` returns for a table-free value (its
// markdown run concatenates token raws, and marked's token raws concatenate to
// the input), so the lex can be skipped entirely.
const GFM_DELIMITER_ROW =
  /^[ \t]*(?=.*[|:])\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/m;

function splitTableSegments(
  value: string,
  previous?: Parameters<typeof splitMarkdownTables>[1]
): MarkdownSplitSegment[] {
  if (!GFM_DELIMITER_ROW.test(value)) {
    return value.length === 0 ? [] : [{ type: 'markdown', raw: value }];
  }
  return splitMarkdownTables(value, previous);
}

function MarkdownContent({
  value,
  palette,
  selectable = true,
  renderScope,
  onLongPressLink,
  onPressLink,
  onCopyCode,
  onLongPressCode,
}: Readonly<MarkdownContentProps>) {
  // Tables are extracted before any renderer runs: each table becomes a chip
  // (parsed on open), and the remaining markdown runs render through useMarkdown.
  // A mount that finds a previously segmented value (a remount of a completed
  // message) reuses the split instead of re-lexing it.
  const [snapshot, setSnapshot] = useState(() => {
    const cached = markdownTableSegmentsCache.get(value);
    if (cached !== undefined) {
      return { value, segments: cached };
    }
    const segments = splitTableSegments(value);
    markdownTableSegmentsCache.set(value, segments);
    return { value, segments };
  });
  const segments = useMemo(() => {
    if (snapshot.value === value) {
      return snapshot.segments;
    }
    // Streaming appends transfer table keys from *this* instance's previous
    // split, and that transfer is not value-pure. The value-only cache cannot
    // carry the snapshot context, so compute against it instead of reading the
    // cache: a foreign no-previous entry (the `useState` initializer above
    // stores one) would hand a newly added table the key of one this instance
    // just invalidated, reconciling live `MarkdownTable` state onto a
    // different table.
    const next = splitTableSegments(value, snapshot);
    markdownTableSegmentsCache.set(value, next);
    return next;
  }, [value, snapshot]);
  if (snapshot.value !== value) {
    setSnapshot({ value, segments });
  }

  return (
    <View>
      {segments.map((segment, index) =>
        segment.type === 'table' ? (
          <MarkdownTable
            key={segment.key}
            palette={palette}
            raw={segment.raw}
            tableKey={segment.key}
            columnCount={segment.columnCount}
            rowCount={segment.rowCount}
            selectable={selectable}
            onLongPressLink={onLongPressLink}
            onPressLink={onPressLink}
          />
        ) : (
          <MarkdownSegment
            key={`md-text-${index}`}
            value={segment.raw}
            palette={palette}
            selectable={selectable}
            renderScope={renderScope}
            onLongPressLink={onLongPressLink}
            onPressLink={onPressLink}
            onCopyCode={onCopyCode}
            onLongPressCode={onLongPressCode}
          />
        )
      )}
    </View>
  );
}

type MarkdownSegmentProps = {
  value: string;
  palette: MarkdownPalette;
  selectable: boolean;
  renderScope?: string;
  onLongPressLink?: MarkdownLinkLongPressHandler;
  onPressLink?: MarkdownLinkPressHandler;
  onCopyCode?: MarkdownCopyCodeHandler;
  onLongPressCode?: MarkdownCodeLongPressHandler;
};

function MarkdownSegment({
  value,
  palette,
  selectable,
  renderScope,
  onLongPressLink,
  onPressLink,
  onCopyCode,
  onLongPressCode,
}: Readonly<MarkdownSegmentProps>) {
  const colorScheme = useColorScheme();
  const renderKey = markdownRenderKey({
    value,
    renderScope,
    palette,
    selectable,
    colorScheme,
    hasLongPressLink: onLongPressLink !== undefined,
    hasPressLink: onPressLink !== undefined,
    hasCopyCode: onCopyCode !== undefined,
    hasLongPressCode: onLongPressCode !== undefined,
  });

  // A row that re-enters the FlashList window remounts this component, and
  // `useMarkdown` would lex and re-create the whole value. A completed value's
  // elements are cached under `renderKey` (value + the render-affecting props),
  // so a remount reuses them and skips the lex. The renderer-per-value contract
  // is what makes this safe: the cached elements came from a renderer built for
  // exactly this value, so their element keys stay stable.
  //
  // The decision is pinned when the instance mounts. Consulting the cache on
  // every render could swap a live parse for cached elements mid-stream and
  // remount the subtree (resetting CodeBlock state); an instance that hits the
  // cache drops back to a live parse only if the value later changes.
  const cachedRef = useRef<{ key: string; entry: MarkdownRenderEntry } | null | undefined>(
    undefined
  );
  if (cachedRef.current === undefined) {
    const cached = markdownRenderCache.get(renderKey);
    cachedRef.current = cached === undefined ? null : { key: renderKey, entry: cached };
  } else if (cachedRef.current !== null && cachedRef.current.key !== renderKey) {
    cachedRef.current = null;
  }

  // Cached elements carry callbacks the renderer captured when they were built.
  // A remount reuses them because the value did not change, but the host may
  // have recomputed its message-bound closures since (a reaction or delivery
  // failure updates the message without its markdown). Re-bind the renderer to
  // the current handlers so a reused fence long-press opens the current
  // message's actions, not the stale ones. A live parse already has them.
  useEffect(() => {
    cachedRef.current?.entry.bindHandlers({
      onLongPressLink,
      onPressLink,
      onCopyCode,
      onLongPressCode,
    });
  });

  return (
    <View>
      {cachedRef.current !== null ? (
        cachedRef.current.entry.elements
      ) : (
        <MarkdownSegmentFresh
          value={value}
          palette={palette}
          selectable={selectable}
          onLongPressLink={onLongPressLink}
          onPressLink={onPressLink}
          onCopyCode={onCopyCode}
          onLongPressCode={onLongPressCode}
          renderKey={renderKey}
          colorScheme={colorScheme}
        />
      )}
    </View>
  );
}

type MarkdownSegmentFreshProps = MarkdownSegmentProps & {
  renderKey: string;
  colorScheme: ColorSchemeName;
};

function MarkdownSegmentFresh({
  value,
  palette,
  selectable,
  onLongPressLink,
  onPressLink,
  onCopyCode,
  onLongPressCode,
  renderKey,
  colorScheme,
}: Readonly<MarkdownSegmentFreshProps>) {
  const styles = useMemo(() => getMarkdownStyles(palette), [palette]);

  const theme = useMemo(
    () => ({
      colors: {
        text: palette.textColor,
        code: palette.textColor,
        link: palette.textColor,
        border: palette.borderColor,
      },
    }),
    [palette]
  );

  // react-native-marked keys elements with a per-instance monotonic slugger;
  // reusing one instance across re-parses re-keys every element and remounts
  // the subtree, resetting local state (e.g. CodeBlock truncation) during
  // streaming. A fresh instance per `value` change yields identical keys for
  // identical parse prefixes, so element state survives while streaming
  // updates flow in as props.
  const renderer = useMemo(
    () =>
      new MarkdownRenderer(palette, selectable, {
        onLongPressLink,
        onPressLink,
        onCopyCode,
        onLongPressCode,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `value` intentionally recreates the renderer per markdown-source change so element keys stay stable across streaming re-parses
    [palette, selectable, onLongPressLink, onPressLink, onCopyCode, onLongPressCode, value]
  );

  const elements = useMarkdown(value, {
    colorScheme,
    theme,
    styles,
    renderer,
  });

  // Hand the parsed elements to the module cache for the next remount. The
  // effect (not render) keeps the render pass free of side effects; the value
  // is already visible by the time a row can leave and re-enter the window. The
  // binder lets a cache hit point this renderer at the host's current handlers,
  // so the reused elements never dispatch through a stale message closure.
  useEffect(() => {
    markdownRenderCache.set(renderKey, {
      elements,
      bindHandlers: handlers => {
        renderer.setHandlers(handlers);
      },
    });
  }, [renderKey, elements, renderer]);

  return <>{elements}</>;
}
