import { useMemo } from 'react';
import { useColorScheme, View } from 'react-native';
import { useMarkdown } from 'react-native-marked';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';

import { getMarkdownStyles, getPalette, type MarkdownVariant } from './markdown-palette';
import {
  type MarkdownLinkLongPressHandler,
  type MarkdownLinkPressHandler,
  MarkdownRenderer,
} from './markdown-renderer';

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
  const colorScheme = useColorScheme();
  const colors = useThemeColors();

  const palette = useMemo(() => getPalette(variant, colors), [variant, colors]);

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
  // the subtree, resetting local state such as MarkdownTable's open modal
  // during streaming. A fresh instance per `value` change yields identical
  // keys for identical parse prefixes, so element state survives while
  // streaming updates flow in as props.
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
