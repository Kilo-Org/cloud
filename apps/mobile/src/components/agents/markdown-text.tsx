import { useMemo, useState } from 'react';
import { useColorScheme, View } from 'react-native';
import { useMarkdown } from 'react-native-marked';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';

import { hasHtmlToken, MarkdownHtml, parseMarkdownHtml } from './markdown-html';
import {
  getMarkdownStyles,
  getPalette,
  type MarkdownPalette,
  type MarkdownVariant,
} from './markdown-palette';
import {
  type MarkdownLinkLongPressHandler,
  type MarkdownLinkPressHandler,
  MarkdownRenderer,
} from './markdown-renderer';
import { MarkdownTable } from './markdown-table';
import { splitMarkdownTables } from './markdown-table-extract';

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
};

export function MarkdownText({
  value,
  variant = 'assistant',
  selectable = true,
  onLongPressLink,
  onPressLink,
}: Readonly<MarkdownTextProps>) {
  const colors = useThemeColors();

  const palette = useMemo(() => getPalette(variant, colors), [variant, colors]);
  const containsHtml = useMemo(() => hasHtmlToken(value), [value]);
  const html = useMemo(
    () => (containsHtml ? parseMarkdownHtml(value) : null),
    [containsHtml, value]
  );

  if (html !== null) {
    return (
      <View>
        <MarkdownHtml
          html={html}
          palette={palette}
          selectable={selectable}
          onLongPressLink={onLongPressLink}
          onPressLink={onPressLink}
        />
      </View>
    );
  }

  return (
    <MarkdownContent
      value={value}
      palette={palette}
      selectable={selectable}
      onLongPressLink={onLongPressLink}
      onPressLink={onPressLink}
    />
  );
}

type MarkdownContentProps = Omit<MarkdownTextProps, 'variant'> & {
  palette: MarkdownPalette;
};

function MarkdownContent({
  value,
  palette,
  selectable = true,
  onLongPressLink,
  onPressLink,
}: Readonly<MarkdownContentProps>) {
  // Tables are extracted before any renderer runs: each table becomes a chip
  // (parsed on open), and the remaining markdown runs render through useMarkdown.
  const [snapshot, setSnapshot] = useState(() => ({ value, segments: splitMarkdownTables(value) }));
  const segments =
    snapshot.value === value ? snapshot.segments : splitMarkdownTables(value, snapshot);
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
            onLongPressLink={onLongPressLink}
            onPressLink={onPressLink}
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
  onLongPressLink?: MarkdownLinkLongPressHandler;
  onPressLink?: MarkdownLinkPressHandler;
};

function MarkdownSegment({
  value,
  palette,
  selectable,
  onLongPressLink,
  onPressLink,
}: Readonly<MarkdownSegmentProps>) {
  const colorScheme = useColorScheme();

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
    () => new MarkdownRenderer(palette, selectable, { onLongPressLink, onPressLink }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `value` intentionally recreates the renderer per markdown-source change so element keys stay stable across streaming re-parses
    [palette, selectable, onLongPressLink, onPressLink, value]
  );

  const elements = useMarkdown(value, {
    colorScheme,
    theme,
    styles,
    renderer,
  });

  return <View>{elements}</View>;
}
