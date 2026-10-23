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
 * {@link DERIVED_CHAT_TEXT_MAX_LENGTH} is cut short at that cap with a trailing
 * ellipsis.
 */
export function derivedChatText(text: string): string {
  const oneLine = text.replaceAll(/\s+/gu, ' ').trim();
  if (oneLine.length <= DERIVED_CHAT_TEXT_MAX_LENGTH) {
    return oneLine;
  }
  return `${cutGraphemes(oneLine, DERIVED_CHAT_TEXT_MAX_LENGTH - 1).trimEnd()}${ELLIPSIS}`;
}

/**
 * The first `count` user-perceived characters of `value`.
 *
 * Cutting by code unit could end a label on half a surrogate pair; cutting by
 * code point could still split a character this reader sees as one, such as a
 * family emoji or a Devanagari syllable with its vowel sign. The segmenter is
 * iterated only as far as the cut, so a long message costs the cap rather than
 * its own length.
 */
function cutGraphemes(value: string, count: number): string {
  let taken = '';
  let seen = 0;
  for (const { segment } of segmenter(i18n.language, { granularity: 'grapheme' }).segment(value)) {
    if (seen === count) {
      break;
    }
    taken += segment;
    seen += 1;
  }
  return taken;
}
