import { UITextView } from '@bsky.app/react-native-uitextview';
import { Fragment, type ReactNode } from 'react';

import { highlightRunChildren } from '@/components/pr-review/diff/highlight-runs';
import { type HighlightToken } from '@/lib/pr-review/diff/highlight';
import { tokenColorForScheme, type TokenScheme } from '@/lib/pr-review/diff/syntax-colors';

/**
 * A blank source line still occupies its line box; an `RNText` whose only
 * child is the empty string collapses to zero height, so a blank line renders
 * a space instead.
 *
 * Only a blank line that sits among other lines needs the placeholder: an
 * empty fence is one blank line and nothing else, so it keeps the zero-height
 * empty code `Text` it rendered before the block chunked the fence (see
 * `keepBlankLineBox` in `CodeBlockImpl`).
 */
const BLANK_CODE_LINE = ' ';

/**
 * Separator between the lines held by one code text.
 */
const CODE_LINE_BREAK = '\n';

/**
 * Children for one code line. Untagged runs are raw strings and
 * tagged runs are nested `RNText`s — see `highlightRunChildren`, which both
 * diff renderers share too. A line whose runs are all empty keeps its blank
 * line box when the fence has another line (`keepBlankLineBox`).
 */
function renderLineRuns(
  tokens: readonly HighlightToken[],
  scheme: TokenScheme,
  keepBlankLineBox: boolean
): ReactNode {
  if (keepBlankLineBox && tokens.every(token => token.text.length === 0)) {
    return BLANK_CODE_LINE;
  }
  return highlightRunChildren(tokens, scheme);
}

/**
 * Children for one chunk of code lines: each line's runs, with a line break
 * before every line but the chunk's first, so the chunk lays out exactly as the
 * lines did when each had its own `Text`. A line whose runs are all empty
 * renders `BLANK_CODE_LINE`, which keeps the line box of a blank line at a
 * chunk's first or last position from collapsing the `Text`; a fence with no
 * other line (`keepBlankLineBox` false) renders that line empty instead.
 */
export function renderChunkChildren(
  chunkLines: readonly (readonly HighlightToken[])[],
  scheme: TokenScheme,
  keepBlankLineBox: boolean
): ReactNode[] {
  return chunkLines.map((tokens, lineIndex) => (
    <Fragment key={`line-${lineIndex}`}>
      {lineIndex > 0 ? CODE_LINE_BREAK : null}
      {renderLineRuns(tokens, scheme, keepBlankLineBox)}
    </Fragment>
  ));
}

/**
 * The same chunk as flat `UITextView` children for the iOS selectable fence.
 * `UITextView` turns a raw string child into a native span and passes an
 * element child through, so a `Fragment` would drop its strings: every run is
 * either a string or a nested `UITextView` carrying its token color.
 */
export function renderSelectableChunkChildren(
  chunkLines: readonly (readonly HighlightToken[])[],
  scheme: TokenScheme,
  keepBlankLineBox: boolean
): ReactNode[] {
  const children: ReactNode[] = [];
  chunkLines.forEach((tokens, lineIndex) => {
    const prefix = lineIndex > 0 ? CODE_LINE_BREAK : '';
    if (keepBlankLineBox && tokens.every(token => token.text.length === 0)) {
      children.push(prefix + BLANK_CODE_LINE);
      return;
    }
    if (prefix) {
      children.push(prefix);
    }
    tokens.forEach((token, tokenIndex) => {
      children.push(
        token.className === null ? (
          token.text
        ) : (
          <UITextView
            key={`tok-${lineIndex}-${tokenIndex}`}
            // eslint-disable-next-line react-native/no-inline-styles -- per-token syntax color
            style={{ color: tokenColorForScheme(token.className, scheme) }}
          >
            {token.text}
          </UITextView>
        )
      );
    });
  });
  return children;
}
