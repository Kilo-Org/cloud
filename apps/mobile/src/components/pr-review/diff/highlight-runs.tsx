// Shared text-run renderer for highlighted code lines.
//
// Android builds one `SpannableStringBuilder` per `ReactTextView` and runs
// `SetSpanOperation.execute` once per span ON THE UI THREAD, so the cost of a
// line is its SPAN COUNT, not its character count. React Native turns every
// nested `Text` child into its own fragment, and each fragment gets a
// `ReactAbsoluteSizeSpan` plus a fragment-index span on top of any color span
// the token asked for.
//
// This helper renders the smallest set of runs for one highlighted line:
// untagged tokens stay raw strings, which React Native's text shadow node
// coalesces into the parent `Text`'s own fragment, and only tagged tokens
// become nested `Text`s. All highlighted surfaces (the chat/tool code block
// and both diff renderers) share it. Each diff row and each chunk of a code
// fence is its own `Text` — a selectable fence chunks the same way, because
// Android selects inside a single `ReactTextView` only, so its selection spans
// the chunk the gesture starts in (see `code-block.tsx`) — so the span ceiling
// is one chunk of lines and a fence pays a span only for its tagged tokens,
// never for its untagged runs.
//
// The caller must give the parent `Text` the base ink (`tokenColorFor(null,
// isDark)` — the theme foreground, or the bubble's text color), which is what
// an untagged run inherits.

import { type ReactNode } from 'react';
// `Text as RNText`: a run must inherit the line Text's own mono font, and the
// shared `@/components/ui/text` would apply its base font classes over it. The
// diff renderers import it the same way.
import { Text as RNText } from 'react-native';

import { type HighlightToken } from '@/lib/pr-review/diff/highlight';
import { tokenColorFor } from '@/lib/pr-review/diff/syntax-colors';

/**
 * Children for one highlighted line: a nested `Text` per tagged token run and
 * a raw string per untagged run.
 */
export function highlightRunChildren(
  tokens: readonly HighlightToken[],
  isDark: boolean
): ReactNode[] {
  return tokens.map((token, index) =>
    token.className === null ? (
      token.text
    ) : (
      // eslint-disable-next-line react-native/no-inline-styles, react-native/no-color-literals -- per-token syntax color
      <RNText key={`tok-${index}`} style={{ color: tokenColorFor(token.className, isDark) }}>
        {token.text}
      </RNText>
    )
  );
}
