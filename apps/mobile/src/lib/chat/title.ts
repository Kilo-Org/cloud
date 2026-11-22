import { type MarkedToken, type Token } from 'marked';

import { lexMarkdown } from '@/components/agents/markdown-parse-cache';
import { firstGraphemes } from '@/lib/graphemes';

/**
 * The longest line a chat derives from a message it holds.
 *
 * A derived title is a label, not the message: it is drawn on one line in the
 * conversation header and in a list row, and it is read out as the rename
 * control's accessible name. Letting it carry the whole body put a 4,771-
 * character string into the accessibility tree three times over in one header.
 *
 * A name someone typed keeps its own limit (`CHAT_TITLE_MAX_LENGTH`), because
 * that one is a name rather than a message.
 */
export const DERIVED_CHAT_TEXT_MAX_LENGTH = 80;

/**
 * How many code units of a stored message a derived label is read from.
 *
 * A label is at most {@link DERIVED_CHAT_TEXT_MAX_LENGTH} characters, so the
 * derivation reads at most this much of the message and costs the label rather
 * than a long body. A message no longer than the window is read whole; a
 * longer one is labelled from its start, at most one code unit past this many
 * when the cut falls inside a surrogate pair (see {@link windowStart}).
 */
export const DERIVED_CHAT_TEXT_SOURCE_WINDOW = 4096;

/**
 * The start of `text`, cut at the window.
 *
 * The cut is widened by one code unit when it would land between the two halves
 * of a surrogate pair, so the lexer never receives an unpaired half. Cutting
 * through one would turn a digit outside the BMP at the window edge into the
 * replacement character, which the 80-character cut guards against in the
 * label itself.
 */
function windowStart(text: string): string {
  if (text.length <= DERIVED_CHAT_TEXT_SOURCE_WINDOW) {
    return text;
  }
  const cut = text.slice(0, DERIVED_CHAT_TEXT_SOURCE_WINDOW);
  // A lone high surrogate at the end of the cut is the first half of a pair the
  // cut split; take the second half with it. With the `u` flag the class matches
  // only a half with no partner, never a complete pair.
  if (/[\uD800-\uDBFF]$/u.test(cut)) {
    return text.slice(0, DERIVED_CHAT_TEXT_SOURCE_WINDOW + 1);
  }
  return cut;
}

const ELLIPSIS = '…';

/**
 * The plain text of inline markdown: emphasis, strong text, inline code,
 * strikethrough, links, images, and backslash escapes are reduced to the text
 * they wrap, so a label built from a message reads as the message and not as
 * its source. A body of nothing but markup reduces to `''`.
 *
 * Line-level markers are handled by the same walk: a heading, list item, or
 * quote contributes the text of its children, never its own `#`, `-`, or `>`.
 *
 * The lexer is the transcript renderer's memoized one, so deriving a title for
 * a message already on screen reuses the tokens that draw it. This function
 * lexes whatever it is given: the caller bounds the source first, so the lexer
 * never sees more of a long message than the caller's window.
 */
function chatPlainText(text: string): string {
  return markedTokensText(lexMarkdown(text), ' ');
}

/**
 * The text of `tokens`, concatenated or separated by `separator`.
 *
 * Blocks are separated so a heading or one list item does not run into the
 * next (`marked` emits no space token between some neighbours); inline runs
 * keep their own spacing, which the caller collapses.
 */
function markedTokensText(tokens: readonly Token[], separator = ''): string {
  return tokens
    .map(
      // `Token` also admits the `Tokens.Generic` shape an extension's tokenizer
      // returns, which gives every field the type `any`. This app registers no
      // extension with `marked`, so every token here is a built-in kind, and
      // the cast says so: it narrows the type at build time and checks nothing.
      token => markedTokenText(token as MarkedToken)
    )
    .join(separator);
}

function markedTokenText(token: MarkedToken): string {
  switch (token.type) {
    case 'space':
    case 'br': {
      return ' ';
    }
    case 'hr':
    case 'def':
    case 'checkbox': {
      return '';
    }
    // An html token's own tags are not text, but its body is what the reader
    // sees: `<br>` separates the words around it and `<p>deploy failed</p>` is
    // that paragraph. Tags become a space rather than nothing so neighbours do
    // not run together; entities stay as the source spells them.
    case 'html': {
      return token.text.replaceAll(/<[^>]*>/gu, ' ');
    }
    case 'code':
    case 'codespan':
    case 'image':
    case 'escape': {
      return token.text;
    }
    case 'blockquote':
    case 'list_item': {
      return markedTokensText(token.tokens, ' ');
    }
    case 'list': {
      return token.items.map(item => markedTokenText(item)).join(' ');
    }
    case 'table': {
      return [
        ...token.header.map(cell => markedTokensText(cell.tokens)),
        ...token.rows.map(row => row.map(cell => markedTokensText(cell.tokens)).join(' ')),
      ].join(' ');
    }
    case 'text':
    case 'paragraph':
    case 'heading':
    case 'strong':
    case 'em':
    case 'del':
    case 'link': {
      return token.tokens === undefined ? token.text : markedTokensText(token.tokens);
    }
    default: {
      // A kind `marked` added after this walk was written, or one an extension
      // emits. A bare `url` keeps its destination; anything else keeps its
      // source, so no text is lost. `MarkedToken` is closed, so the type
      // checker sees `never` here and the cast is the only way to read a field.
      const unknown = token as { type: string; raw: string; href?: string };
      return unknown.type === 'url' ? (unknown.href ?? unknown.raw) : unknown.raw;
    }
  }
}

/**
 * A message reduced to one short line derived from its start, at most
 * {@link DERIVED_CHAT_TEXT_SOURCE_WINDOW} code units of it (one more when the
 * window ends inside a surrogate pair): inline markdown is reduced to the text
 * it wraps, whitespace runs (line breaks included) collapse to single spaces,
 * the ends are trimmed, and a line longer than
 * {@link DERIVED_CHAT_TEXT_MAX_LENGTH} characters is cut short at that cap with
 * a trailing ellipsis. A line that fits keeps its characters: the ellipsis
 * means a cut happened, never that the cap was counted in a different unit.
 *
 * The source is bounded before it is read, so the cost of a label is the label
 * rather than the length of the stored message; a message longer than the
 * window is labelled from the start of its body, and the rest is never read.
 */
export function derivedChatText(text: string): string {
  const source = windowStart(text);
  const oneLine = chatPlainText(source).replaceAll(/\s+/gu, ' ').trim();
  // A string no longer than the cap in code units holds no more characters
  // than that, so the common short message never reaches the segmenter.
  if (oneLine.length <= DERIVED_CHAT_TEXT_MAX_LENGTH) {
    return oneLine;
  }
  const head = firstGraphemes(oneLine, DERIVED_CHAT_TEXT_MAX_LENGTH);
  if (!head.more) {
    return oneLine;
  }
  const cut = firstGraphemes(oneLine, DERIVED_CHAT_TEXT_MAX_LENGTH - 1).text;
  return `${cut.trimEnd()}${ELLIPSIS}`;
}
