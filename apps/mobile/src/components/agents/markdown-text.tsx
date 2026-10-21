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
  type MarkdownHtmlSnapshot,
  splitMarkdownHtmlIncremental,
} from './markdown-html';
import { MarkdownMermaid } from './markdown-mermaid';
import { getPalette, type MarkdownPalette, type MarkdownVariant } from './markdown-palette';
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
          <MarkdownRun
            key={`md-content-${index}`}
            raw={segment.raw}
            palette={palette}
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
              selectable={selectable}
              onLongPressLink={onLongPressLink}
              onPressLink={onPressLink}
              onCopyCode={onCopyCode}
            />
          );
        }
        return run.language === 'mermaid' && run.closed ? (
          <MarkdownMermaid key={`md-fence-${index}`} source={run.code} palette={palette} />
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
