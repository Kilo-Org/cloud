import { Fragment, memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type LayoutChangeEvent, Text as RNText, View } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { tokenColorFor } from '@/lib/pr-review/diff/syntax-colors';

import { useTranscriptTextSelectable } from './bubble-text-selection-context';
import { tokenizeCodeLines } from './code-block-model';
import { useMonoScrollSheet } from './mono-scroll-block';
import {
  MONO_SCROLL_VIEW_PROPS,
  type MonoScrollHeightPin,
  nextMonoScrollHeightPin,
  prepareMonoScrollContent,
  resolveMonoScrollPinnedHeight,
} from './mono-scroll-block-model';

type CodeBlockProps = {
  code: string;
  language: string | null;
  /** Char cap; on overflow slice and show the Truncated marker. */
  maxLength?: number;
  /** Default: useTranscriptTextSelectable(). */
  selectable?: boolean;
  /** Base (plain-text) color. Default: useThemeColors().foreground.
      The markdown renderer passes palette.textColor so code inside user
      variant bubbles keeps its designed ink color (lime/primary surfaces). */
  baseColor?: string;
};

/**
 * Shared highlighted code block for tool detail sheets and markdown fences.
 *
 * Each line is highlighted independently by `highlightLine` (the per-line
 * ceiling documented in `highlight.ts`); the tokens render as nested RNText
 * runs inside one selectable parent RNText, mirroring the shipped `DiffLine`
 * pattern. `SelectableText` cannot carry colored runs, so highlighted code
 * accepts the documented iOS select-callout trade-off (see
 * `selectable-text.tsx`) — plain text surfaces (list rows, todo rows) keep
 * true `SelectableText`.
 *
 * Sheet contract: inside the tool detail sheet the block reads the mono
 * sheet context, registers presence through `track()`, and honors the sheet's
 * wrap/scroll mode. Scroll mode reuses `MONO_SCROLL_VIEW_PROPS` and the
 * height-pin model from `mono-scroll-block-model.ts`. Outside the sheet
 * (chat bubbles) the mode is always `wrap` — the no-nested-horizontal-
 * ScrollView rule that protects RN 0.83 Fabric from spurious heights.
 */
function CodeBlockImpl({
  code,
  language,
  maxLength,
  selectable,
  baseColor,
}: Readonly<CodeBlockProps>) {
  const sheet = useMonoScrollSheet();
  const textMode = sheet?.mode ?? 'wrap';
  const track = sheet?.track;
  const textSelectable = useTranscriptTextSelectable();
  const effectiveSelectable = selectable ?? textSelectable;
  const colors = useThemeColors();
  const { t } = useTranslation();
  const isDark = colors.background === '#0E0E10';
  const { displayText, isTruncated } = prepareMonoScrollContent(code, maxLength);
  const tokenLines = useMemo(
    () => tokenizeCodeLines(displayText, language),
    [displayText, language]
  );
  const [heightPin, setHeightPin] = useState<MonoScrollHeightPin | undefined>(undefined);
  const contentHeight = resolveMonoScrollPinnedHeight(heightPin, displayText);
  const textBase = baseColor ?? colors.foreground;

  // Registers this block's presence exactly once per mount; the cleanup is the
  // unregister. The effect only re-runs when `track` identity changes, which
  // the sheet keeps stable, so mode flips never re-register.
  useEffect(() => track?.(), [track]);

  const handleContentLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const measured = event.nativeEvent.layout.height;
      setHeightPin(prev => nextMonoScrollHeightPin(prev, displayText, measured));
    },
    [displayText]
  );

  const content = tokenLines.map((tokens, lineIndex) => (
    <Fragment key={`line-${lineIndex}`}>
      {lineIndex > 0 ? '\n' : null}
      {tokens.map((token, tokenIndex) => {
        const color = token.className === null ? textBase : tokenColorFor(token.className, isDark);
        return (
          // eslint-disable-next-line react-native/no-inline-styles, react-native/no-color-literals -- per-token syntax color
          <RNText key={`tok-${tokenIndex}`} style={{ color }}>
            {token.text}
          </RNText>
        );
      })}
    </Fragment>
  ));

  const truncatedMarker = isTruncated ? (
    <Text
      accessibilityLabel={t('monoScrollBlock.contentTruncated')}
      className="mt-1 text-xs text-muted-foreground"
    >
      {t('monoScrollBlock.truncated')}
    </Text>
  ) : null;

  if (textMode === 'wrap') {
    return (
      <View>
        <RNText selectable={effectiveSelectable} className="font-mono text-xs leading-4">
          {content}
        </RNText>
        {truncatedMarker}
      </View>
    );
  }

  return (
    <View>
      <ScrollView
        {...MONO_SCROLL_VIEW_PROPS}
        // Explicit height from measured content — see MonoScrollBlock's doc.
        // eslint-disable-next-line react-native/no-inline-styles -- measured height cannot be a Tailwind class
        style={contentHeight === undefined ? undefined : { height: contentHeight }}
      >
        <RNText
          selectable={effectiveSelectable}
          onLayout={handleContentLayout}
          className="shrink-0 self-start font-mono text-xs leading-4"
        >
          {content}
        </RNText>
      </ScrollView>
      {truncatedMarker}
    </View>
  );
}

export const CodeBlock = memo(CodeBlockImpl);
