import { i18n } from '@/i18n';
import { segmenter } from '@/lib/intl-cache';

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

const ELLIPSIS = '…';

/**
 * A message reduced to one short line: whitespace runs (line breaks included)
 * collapse to single spaces, the ends are trimmed, and a line longer than
 * {@link DERIVED_CHAT_TEXT_MAX_LENGTH} characters is cut short at that cap with
 * a trailing ellipsis. A line that fits keeps its characters: the ellipsis
 * means a cut happened, never that the cap was counted in a different unit.
 */
export function derivedChatText(text: string): string {
  const oneLine = text.replaceAll(/\s+/gu, ' ').trim();
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

/**
 * The first `count` user-perceived characters of `value`, and whether the value
 * holds more.
 *
 * Cutting by code unit could end a label on half a surrogate pair; cutting by
 * code point could still split a character this reader sees as one, such as a
 * family emoji or a Devanagari syllable with its vowel sign. The segmenter is
 * iterated only as far as `count` plus one, so a long message costs the cap
 * rather than its own length.
 */
function firstGraphemes(value: string, count: number) {
  let text = '';
  let seen = 0;
  for (const { segment } of segmenter(i18n.language, { granularity: 'grapheme' }).segment(value)) {
    if (seen === count) {
      return { text, more: true };
    }
    text += segment;
    seen += 1;
  }
  return { text, more: false };
}
