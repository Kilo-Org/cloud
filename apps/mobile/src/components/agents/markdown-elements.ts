import { type ReactNode, useMemo } from 'react';
import { type Token } from 'marked';
import { type ColorSchemeName } from 'react-native';
import { type MarkedStyles, type RendererInterface } from 'react-native-marked';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- the package ships no declarations for its compiled deep modules
// @ts-expect-error -- getStyles is not exported from the package entry
import getStylesModule from 'react-native-marked/dist/module/theme/styles';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- the package ships no declarations for its compiled deep modules
// @ts-expect-error -- Parser is not exported from the package entry
import ParserModule from 'react-native-marked/dist/module/lib/Parser';

import { getLexedMarkdown } from './markdown-parse-cache';

type UserTheme = {
  colors?: Record<string, string>;
  spacing?: Record<string, number>;
};

type GetStyles = (
  userStyles?: MarkedStyles,
  colorScheme?: ColorSchemeName,
  userTheme?: UserTheme
) => MarkedStyles;

type ParserInstance = {
  parse: (tokens: Token[]) => ReactNode[];
};

type ParserConstructor = new (options: {
  styles: MarkedStyles;
  baseUrl?: string;
  renderer: RendererInterface;
}) => ParserInstance;

const getStyles = getStylesModule as GetStyles;
const Parser = ParserModule as ParserConstructor;

export type MarkdownElementsOptions = {
  /**
   * The element renderer for this value. The caller owns its lifetime because
   * react-native-marked's monotonic key slugger has to restart per value for
   * element keys (and local state, such as CodeBlock truncation) to survive a
   * streaming re-parse. See `MarkdownSegment` in markdown-text.tsx.
   */
  renderer: RendererInterface;
  colorScheme?: ColorSchemeName;
  theme?: UserTheme;
  styles?: MarkedStyles;
  baseUrl?: string;
};

/**
 * react-native-marked's `useMarkdown`, but lexing through the shared
 * `getLexedMarkdown` cache instead of `marked.lexer` per instance. The styles
 * and parser memos mirror the library hook exactly; only the lex source
 * differs, so an unchanged value that remounts (a transcript row re-entering
 * the list window) reuses its tokens and skips the lex. The parser still runs
 * per parse, because it walks the element renderer and that has to stay fresh
 * per value for stable keys.
 */
export function useMarkdownElements(value: string, options: MarkdownElementsOptions): ReactNode[] {
  const styles = useMemo(
    () => getStyles(options.styles, options.colorScheme, options.theme),
    [options.styles, options.theme, options.colorScheme]
  );

  const parser = useMemo(
    () =>
      new Parser({
        styles,
        baseUrl: options.baseUrl,
        renderer: options.renderer,
      }),
    [options.renderer, options.baseUrl, styles]
  );

  return useMemo(() => parser.parse(getLexedMarkdown(value)), [value, parser]);
}
