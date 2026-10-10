import { useMemo, useRef } from 'react';
import { View } from 'react-native';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';

import { MarkdownEnriched } from './markdown-enriched';
import {
  type MarkdownCopyCodeHandler,
  type MarkdownLinkLongPressHandler,
  type MarkdownLinkPressHandler,
} from './markdown-handlers';
import { convertHtmlToMarkdown } from './markdown-html-convert';
import {
  MarkdownHtml,
  type MarkdownHtmlSnapshot,
  splitMarkdownHtmlIncremental,
} from './markdown-html';
import { MarkdownMermaid } from './markdown-mermaid';
import { getPalette, type MarkdownVariant } from './markdown-palette';
import { markdownHtmlSplitCache } from './markdown-parse-cache';

export type MarkdownTextProps = {
  value: string;
  variant?: MarkdownVariant;
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
   * When omitted, fences render with no copy button.
   */
  onCopyCode?: MarkdownCopyCodeHandler;
};

export function MarkdownText({
  value,
  variant = 'assistant',
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
  // next value still extends the snapshot.
  const snapshotRef = useRef<MarkdownHtmlSnapshot | undefined>(undefined);
  const { segments, snapshot } = useMemo(() => {
    // A remount (a FlashList row re-entering the window) starts without a
    // snapshot, so the incremental parser can only rebuild the whole value.
    // Completed values were cached on the previous mount — including the last
    // streaming publish, which is the value a remount sees — so reuse that
    // parse instead of lexing and segmenting the same source again.
    const cached =
      snapshotRef.current === undefined ? markdownHtmlSplitCache.get(value) : undefined;
    // HTML that markdown can express becomes markdown first, so it renders
    // natively; only the rest reaches the HTML engine.
    const result =
      cached ?? splitMarkdownHtmlIncremental(convertHtmlToMarkdown(value), snapshotRef.current);
    markdownHtmlSplitCache.set(value, result);
    return result;
  }, [value]);
  snapshotRef.current = snapshot;

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
