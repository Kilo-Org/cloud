import { i18n } from '@/i18n';
import { segmenter } from '@/lib/intl-cache';

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
export function firstGraphemes(value: string, count: number) {
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
